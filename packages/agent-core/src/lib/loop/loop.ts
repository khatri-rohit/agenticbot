import { randomUUID } from 'node:crypto';
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';

import {
  CHARS_PER_TOKEN,
  emptyRunUsage,
  limitMessage,
  type RunUsage,
  type TraceEvent,
} from '@agent/agent-models';

import { refreshContextReport } from '../context/assemble-context';
import { consoleTrace } from '../events/trace';
import { estimatePromptTokens } from '../model/estimate-prompt-tokens';
import { TaskStateTracker } from '../state/task-state';
import { withStateCard } from './state-card';
import {
  createEffortRouter,
  type EffortDecision,
  type EffortSignals,
} from '../system1/effort';
import { buildEffortState } from '../system1/state';
import { getSkill } from '../tools/skills';
import type { ToolRegistry } from '../tools/types';
import {
  appendDurable,
  createRunState,
  noteLimit,
  type CoreResult,
  type LoopConfig,
  type RunState,
} from './run-state';
import { throwIfAborted } from './timeout';
import { preview } from './tool-call-record';
import { completeAfterLimit, finishPaused, settleFinalAnswer } from './turn-finish';
import { runToolTurn } from './turn-tools';
import type { ModelCallFn, RunLoopConfig, RunLoopResult } from './types';

export type {
  ModelCallFn,
  RunLoopConfig,
  RunLoopResult,
  RunLoopStatus,
} from './types';

/*
 * The run is split by phase:
 * - run-state.ts      what one run shares (budget, guards, record, counters)
 * - loop.ts           this file: the iteration, the model call, the error path
 * - turn-tools.ts     admit, gate, stage and execute one turn's tool calls
 * - residency-pass.ts shrink the live prompt after a tool turn
 * - steering-notes.ts harness notes (budget, stall, advisor)
 * - turn-finish.ts    final answer, limit handoff, pause, requested stop
 */

/**
 * The agent state machine. Iterates: model call → tool execution → next model call.
 *
 * Contract: observe tools per *turn* (batch → append every tool_call_id → next
 * model call). Never model-after-each-tool. Gates dispose; prompts do not.
 * Emits AgentEvents via config.emit (for SSE/UI) AND traces via config.trace
 * (for eval/console). Durable turns go through config.onMessage (host ledger).
 *
 * The wrapper owns run-wide accounting: every result carries token usage
 * (own + sub-agents), and one `run_finish` trace closes the run whichever
 * path ended it.
 */
export async function runLoop(
  modelCall: ModelCallFn,
  messages: ChatCompletionMessageParam[],
  tools: ToolRegistry,
  config: RunLoopConfig,
): Promise<RunLoopResult> {
  const runId = config.runId ?? randomUUID();
  const sink = config.trace ?? ((event: TraceEvent) => consoleTrace(event));
  // Task state is reduced from the same event stream the sink records, so an
  // offline reader can rebuild it from the trace; phase changes are traced
  // right after the event that caused them.
  const task = new TaskStateTracker();
  const trace = (event: TraceEvent): void => {
    sink(event);
    const change = task.apply(event);
    if (change) sink({ type: 'task_phase', runId, iteration: task.iteration, ...change });
  };
  const usage = emptyRunUsage();
  const startedAt = Date.now();
  const result = await runLoopCore(modelCall, messages, tools, {
    ...config,
    runId,
    trace,
    task,
  }, usage, startedAt);
  await reportSystem1(config, runId, trace);
  sink({ type: 'task_state', runId, state: task.snapshot() });
  trace({
    type: 'run_finish',
    runId,
    iterations: result.iterations,
    toolCalls: result.toolCalls,
    status: result.status,
    ...(result.limitReason ? { limitReason: result.limitReason } : {}),
    usage,
    durationMs: Date.now() - startedAt,
    ...(config.signal?.aborted ? { cancelled: true as const } : {}),
  });
  return {
    ...result,
    usage,
    ...(config.contextReport
      ? { contextReport: refreshContextReport(config.contextReport, messages, tools) }
      : {}),
  };
}

/**
 * End-of-run System 1 summary: always to the trace, and to the client when
 * any decision fell back. Sub-agent runs report through their own trace only.
 * Never throws — reporting must not change how the run ended.
 */
async function reportSystem1(
  config: RunLoopConfig,
  runId: string,
  trace: (event: TraceEvent) => void,
): Promise<void> {
  const system1 = config.system1;
  if (!system1) return;
  try {
    await system1.settle();
    const report = system1.report();
    if (!report) return;
    trace({ type: 'system1_report', runId, report });
    if (report.fallbacks.length > 0 && (config.depth ?? 0) === 0) {
      config.emit?.({ type: 'system1.report', runId, report });
    }
  } catch (error) {
    console.error('[system1] report failed:', error instanceof Error ? error.message : error);
  }
}

/**
 * reasoning_effort to override for this call, or undefined to send the
 * baseline. System 1's routed rung applies as before; with escalation on, a
 * tool error or a steering note raises the rest of the run to one rung above
 * the baseline (a routed rung higher than that still wins). Never lowers.
 */
function escalateEffort(
  s: RunState,
  effort: EffortDecision,
  cause: { toolError: boolean; nudged: boolean },
): string | undefined {
  const routed = effort.applied && effort.wire !== undefined ? effort.wire : undefined;
  const ladder = s.config.effortPolicy?.ladder;
  const base = s.config.effortPolicy?.baselineIndex;
  if (!s.flags.effortEscalation || !ladder || base === undefined || base < 0) return routed;
  const from = ladder[base];
  const up = ladder[base + 1];
  if (!from || !up) return routed;
  if (!s.escalated && (cause.toolError || cause.nudged)) {
    s.escalated = true;
    s.trace({
      type: 'effort_escalated',
      runId: s.runId,
      iteration: s.iterations,
      from: from.wire,
      to: up.wire,
      reason: cause.toolError ? 'tool_error' : 'steering',
    });
  }
  if (!s.escalated) return routed;
  const routedIndex = routed === undefined ? -1 : ladder.findIndex((rung) => rung.wire === routed);
  return routedIndex > base + 1 ? routed : up.wire;
}

async function runLoopCore(
  modelCall: ModelCallFn,
  messages: ChatCompletionMessageParam[],
  tools: ToolRegistry,
  config: LoopConfig,
  usage: RunUsage,
  runStartedAt: number,
): Promise<CoreResult> {
  const s = createRunState(modelCall, messages, tools, config, usage, runStartedAt);
  const { runId, threadId, signal, limits, budget, trace, emit, recorder, turnSignals } = s;
  const effortRouter = createEffortRouter();

  trace({
    type: 'run_start',
    runId,
    model: config.model,
    threadId,
    ...(config.parentRunId ? { parentRunId: config.parentRunId } : {}),
    depth: config.depth ?? 0,
    mode: config.mode,
    posture: s.posture,
    windowTokens: s.contextBudget.windowTokens,
    flags: s.flags,
    ...(config.modelSettings ? { modelSettings: config.modelSettings } : {}),
    ...(config.contextReport?.windowSource
      ? { windowSource: config.contextReport.windowSource }
      : {}),
    ...(config.contextReport
      ? {
          occupiedTokens: config.contextReport.occupiedTokens,
          layers: config.contextReport.layers,
        }
      : {}),
  });
  emit?.({
    type: 'run.started',
    runId,
    threadId,
    mode: config.mode,
    posture: s.posture,
    model: config.model,
    ...(config.estimatedPromptTokens !== undefined
      ? { estimatedPromptTokens: config.estimatedPromptTokens }
      : {}),
    ...(config.contextReport ? { contextReport: config.contextReport } : {}),
    ...(config.modelSettings ? { modelSettings: config.modelSettings } : {}),
    ...(limits.maxPromptTokens !== undefined
      ? { maxPromptTokens: limits.maxPromptTokens }
      : {}),
    startedAt: new Date(runStartedAt).toISOString(),
  });
  for (const name of config.pinnedSkills ?? []) {
    const skill = getSkill(name);
    if (!skill) continue;
    trace({
      type: 'skill_loaded',
      runId,
      iteration: 0,
      name: skill.name,
      tokens: Math.ceil(skill.instructions.length / CHARS_PER_TOKEN),
      source: 'pick',
    });
  }

  // Hoisted so the catch can skip any unanswered tool calls of the turn in
  // progress when the loop throws — upholds I1 (every tool_call_id gets one
  // durable tool row) on the error path.
  let turnToolCalls: ChatCompletionMessageToolCall[] = [];
  try {
    while (
      limits.maxIterations === undefined ||
      s.iterations < limits.maxIterations
    ) {
      throwIfAborted(signal);
      s.iterations++;

      const estimatedPrompt = estimatePromptTokens(messages, tools.definitions);
      // The first call always runs: skipping it to finalize would cost the same.
      const overBudget = budget.exceeded(s.iterations > 1 ? estimatedPrompt : 0);
      if (overBudget) {
        s.iterations--;
        noteLimit(s, overBudget);
        return await completeAfterLimit(s);
      }
      const capacityPause = config.capacity?.pauseReason() ?? null;
      if (capacityPause) {
        s.iterations--;
        return finishPaused(s, capacityPause);
      }

      const nudged = turnSignals.nudged;
      const effortSignals: EffortSignals = {
        iteration: s.iterations,
        steering: nudged || messages[messages.length - 1]?.role === 'user',
        toolError: turnSignals.toolError,
        wrote: turnSignals.wrote,
      };
      turnSignals.toolError = false;
      turnSignals.wrote = false;
      turnSignals.nudged = false;
      const decisionIteration = s.iterations;
      const effort = await effortRouter.decide({
        policy: config.effortPolicy,
        system1: config.system1,
        signals: effortSignals,
        state: () =>
          buildEffortState({
            messages,
            runStart: s.runStart,
            signals: effortSignals,
            ...(limits.maxIterations !== undefined ? { maxIterations: limits.maxIterations } : {}),
            mode: config.mode,
          }),
        ...(signal ? { signal } : {}),
        onTrace: (decision) =>
          trace({ type: 'system1_decision', runId, iteration: decisionIteration, decision }),
      });
      throwIfAborted(signal);
      if (effort.trace) {
        trace({ type: 'system1_decision', runId, iteration: s.iterations, decision: effort.trace });
      }
      const effortOverride = escalateEffort(s, effort, {
        toolError: effortSignals.toolError,
        nudged,
      });
      const sentEffort = effortOverride ?? effort.wire;

      // The live prompt plus this step's harness card (ephemeral: rebuilt
      // from state each call, never stored in messages or the ledger).
      const sent = withStateCard(s, messages, estimatedPrompt);

      trace({
        type: 'llm_request',
        runId,
        iteration: s.iterations,
        estimatedPromptTokens: estimatedPrompt,
        ...(sentEffort !== undefined ? { reasoningEffort: sentEffort } : {}),
        ...(recorder ? { input: recorder.input(sent, tools) } : {}),
      });
      emit?.({ type: 'turn.started', runId, iteration: s.iterations });

      const messageId = randomUUID();
      const onTextDelta = (delta: string) => {
        emit?.({
          type: 'assistant.delta',
          runId,
          messageId,
          delta,
        });
      };

      emit?.({ type: 'assistant.started', runId, messageId });

      // duration = model-call + stream time; excludes tool execution (on ToolCompleted).
      const startedAt = Date.now();
      const turn = await modelCall(
        config.model,
        sent,
        tools,
        onTextDelta,
        signal,
        effortOverride !== undefined ? { reasoningEffort: effortOverride } : undefined,
      );
      throwIfAborted(signal);
      const durationMs = Date.now() - startedAt;
      const usageEstimated = budget.chargeOwn(turn.usage, estimatedPrompt, turn.content);

      trace({
        type: 'llm_response',
        runId,
        iteration: s.iterations,
        finishReason: turn.finishReason,
        hasToolCalls: Boolean(turn.toolCalls.length),
        contentPreview: turn.content ? preview(turn.content) : undefined,
        ...(turn.usage ? { usage: turn.usage } : {}),
        durationMs,
        ...(usageEstimated ? { usageEstimated } : {}),
        ...(recorder ? { output: recorder.output(turn) } : {}),
      });

      if (turn.toolCalls.length > 0) {
        await appendDurable(
          s,
          {
            role: 'assistant',
            content: turn.content || null,
            tool_calls: turn.toolCalls,
          },
          { durationMs, messageId },
        );
        turnToolCalls = turn.toolCalls;

        // Tool turns end like any other: the ledger row is durable, so the
        // client can settle this assistant message before tools run.
        emit?.({
          type: 'assistant.completed',
          runId,
          messageId,
          content: turn.content,
          durationMs,
        });

        const ended = await runToolTurn(s, turn);
        if (ended) return ended;
        continue;
      }

      const settled = await settleFinalAnswer(s, turn, messageId, durationMs);
      if (settled) return settled;
    }

    // Max iterations exceeded — finalize without tools.
    noteLimit(
      s,
      limitMessage(
        'limit.iterations',
        `max iterations exceeded (${limits.maxIterations})`,
      ),
    );

    return await completeAfterLimit(s);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Usage limit (e.g. Ollama 429 "session usage limit"): pause, not error.
    const capacityReason = signal?.aborted
      ? null
      : (config.capacity?.limitReasonFor(error) ?? null);

    // I1: close the gap on the error path. A throw mid-turn can leave
    // tool_call_ids without a durable tool row; the ledger is the truth.
    if (turnToolCalls.length > 0) {
      try {
        await s.record.skip(
          turnToolCalls,
          capacityReason ? 'Skipped: account usage limit reached.' : 'Skipped: run errored.',
        );
      } catch {
        /* best-effort; the run is already failing */
      }
    }
    if (capacityReason) return finishPaused(s, capacityReason);

    trace({
      type: 'tool_error',
      runId,
      iteration: s.iterations,
      toolName: 'agent',
      error: message,
    });
    emit?.({ type: 'run.error', runId, error: message });

    return {
      runId,
      content: `Agent error: ${message}`,
      iterations: s.iterations,
      toolCalls: s.totalToolCalls,
      status: 'error',
    };
  }
}
