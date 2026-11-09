import { randomUUID } from 'node:crypto';

import { limitMessage, type ModelTurn, type TokenUsage } from '@agent/agent-models';

import { stubLiveToolResults } from '../context/assemble-context';
import { estimatePromptTokens } from '../model/estimate-prompt-tokens';
import type { ToolRegistry } from '../tools/types';
import {
  appendDurable,
  emitTurnCompleted,
  lastAssistantContent,
  noteLimit,
  pushHarnessNote,
  type CoreResult,
  type RunState,
} from './run-state';
import { OPEN_PLAN_WORK_NUDGE } from './steering-notes';
import { preview } from './tool-call-record';

/** Tools-off final call after a limit; doubles as the handoff the next run continues from. */
const LIMIT_HANDOFF_INSTRUCTION =
  'This run stopped at a limit; tools are off. If the request can be answered from the information above, answer it now and say what is uncertain. Otherwise write a short handoff for the next run: what is done (files changed, what was verified), what is left, and the exact next step.';

/** Tools-off final call after the user skipped an offer_choice: a summary they can decide from. */
const DEFERRED_CHOICE_INSTRUCTION =
  'The user skipped your question to decide later; tools are off. Do not pick an option or continue the work. Write the reply they will decide from: 1) one or two lines on what was done so far and where it stopped; 2) the open question; 3) each option by its label: what it would do, its trade-offs (effort, risk, what it changes) and when it is the right pick; 4) your recommendation and why; 5) how to answer next time (for example "Go with <label>", several options, or other direction). Keep it scannable.';

/** Tools-off final answer with a fresh message lifecycle (never reuse the tool-turn id). */
async function finalizeAnswer(
  s: RunState,
  instruction: string,
): Promise<{ content: string; usage?: TokenUsage }> {
  const { runId, emit, recorder } = s;
  const finalMessageId = randomUUID();
  const onTextDelta = (delta: string) => {
    emit?.({
      type: 'assistant.delta',
      runId,
      messageId: finalMessageId,
      delta,
    });
  };

  emit?.({ type: 'assistant.started', runId, messageId: finalMessageId });

  // The instruction joins the live `messages` only: it is loop control
  // flow, not a durable turn, so it must never hit onMessage.
  pushHarnessNote(s, instruction);
  const noTools: ToolRegistry = { definitions: [], byName: new Map() };
  // The tool-less finalize prompt is everything in `messages` right now.
  const estimatedPrompt = estimatePromptTokens(s.messages);
  s.trace({
    type: 'llm_request',
    runId,
    iteration: s.iterations,
    estimatedPromptTokens: estimatedPrompt,
    final: true,
    ...(recorder ? { input: recorder.input(s.messages, noTools) } : {}),
  });

  // duration = model-call + stream time; excludes tool execution (on ToolCompleted).
  const startedAt = Date.now();
  const turn = await s.modelCall(s.config.model, s.messages, noTools, onTextDelta, s.signal);
  const content = turn.content ?? '';
  const durationMs = Date.now() - startedAt;
  const usageEstimated = s.budget.chargeOwn(turn.usage, estimatedPrompt, turn.content);
  s.trace({
    type: 'llm_response',
    runId,
    iteration: s.iterations,
    finishReason: turn.finishReason,
    hasToolCalls: false,
    contentPreview: content ? preview(content) : undefined,
    ...(turn.usage ? { usage: turn.usage } : {}),
    durationMs,
    ...(usageEstimated ? { usageEstimated } : {}),
    final: true,
    ...(recorder ? { output: recorder.output(turn) } : {}),
  });

  await appendDurable(
    s,
    {
      role: 'assistant',
      content,
    },
    { durationMs, runDurationMs: Date.now() - s.runStartedAt },
  );

  emit?.({
    type: 'assistant.completed',
    runId,
    messageId: finalMessageId,
    content,
    durationMs,
  });

  return { content, usage: turn.usage };
}

/**
 * Account capacity ran out (or is about to). No final model call: it would
 * fail or spend the last of the allowance. The ledger and plan carry the
 * state; the next run continues from them.
 */
export function finishPaused(s: RunState, reason: string): CoreResult {
  noteLimit(s, limitMessage('limit.capacity', reason));
  emitTurnCompleted(s, s.iterations);
  s.emit?.({
    type: 'run.completed',
    runId: s.runId,
    iterations: s.iterations,
    toolCalls: s.totalToolCalls,
    incomplete: true,
    ...(s.lastLimitReason ? { limitReason: s.lastLimitReason } : {}),
  });
  return {
    runId: s.runId,
    content: lastAssistantContent(s),
    iterations: s.iterations,
    toolCalls: s.totalToolCalls,
    status: 'incomplete',
    ...(s.lastLimitReason ? { limitReason: s.lastLimitReason } : {}),
  };
}

export async function completeAfterLimit(s: RunState): Promise<CoreResult> {
  stubLiveToolResults(s.messages, s.contextBudget, s.runStart, s.flags);
  const final = await finalizeAnswer(s, LIMIT_HANDOFF_INSTRUCTION);
  emitTurnCompleted(s, s.iterations, final.usage);
  s.emit?.({
    type: 'run.completed',
    runId: s.runId,
    iterations: s.iterations,
    toolCalls: s.totalToolCalls,
    incomplete: true,
    ...(s.lastLimitReason ? { limitReason: s.lastLimitReason } : {}),
  });
  return {
    runId: s.runId,
    content: final.content,
    iterations: s.iterations,
    toolCalls: s.totalToolCalls,
    status: 'incomplete',
    ...(s.lastLimitReason ? { limitReason: s.lastLimitReason } : {}),
  };
}

/**
 * The user skipped an offer_choice: they will decide later, so the run
 * ends with a tools-off summary of the open choice, not as incomplete.
 */
export async function completeAfterDeferredChoice(s: RunState): Promise<CoreResult> {
  stubLiveToolResults(s.messages, s.contextBudget, s.runStart, s.flags);
  const final = await finalizeAnswer(s, DEFERRED_CHOICE_INSTRUCTION);
  emitTurnCompleted(s, s.iterations, final.usage);
  s.emit?.({
    type: 'run.completed',
    runId: s.runId,
    iterations: s.iterations,
    toolCalls: s.totalToolCalls,
  });
  return {
    runId: s.runId,
    content: final.content,
    iterations: s.iterations,
    toolCalls: s.totalToolCalls,
    status: 'completed',
  };
}

/** A tool (sub-agent `report`) asked to end the run with this answer. */
export async function finishRequestedStop(
  s: RunState,
  content: string,
  lastUsage?: TokenUsage,
): Promise<CoreResult> {
  await appendDurable(
    s,
    { role: 'assistant', content },
    { runDurationMs: Date.now() - s.runStartedAt },
  );
  emitTurnCompleted(s, s.iterations, lastUsage);
  s.emit?.({
    type: 'run.completed',
    runId: s.runId,
    iterations: s.iterations,
    toolCalls: s.totalToolCalls,
  });
  return {
    runId: s.runId,
    content,
    iterations: s.iterations,
    toolCalls: s.totalToolCalls,
    status: 'completed',
  };
}

/**
 * A model turn with no tool calls: the final answer. Returns null when the
 * loop should take another turn (one nudge while plan todos are open).
 */
export async function settleFinalAnswer(
  s: RunState,
  turn: ModelTurn,
  messageId: string,
  durationMs: number,
): Promise<CoreResult | null> {
  const { runId, emit } = s;
  // durationMs is this call; runDurationMs is the whole run the user waited for.
  await appendDurable(
    s,
    {
      role: 'assistant',
      content: turn.content ?? '',
    },
    { durationMs, runDurationMs: Date.now() - s.runStartedAt },
  );

  emit?.({
    type: 'assistant.completed',
    runId,
    messageId,
    content: turn.content,
    durationMs,
  });

  if (turn.finishReason === 'stop') {
    const result = turn.content ?? '';
    const openPlanWork = s.config.hasOpenPlanWork
      ? await s.config.hasOpenPlanWork()
      : false;

    if (openPlanWork && s.planWorkNudges < 1) {
      s.planWorkNudges += 1;
      pushHarnessNote(s, OPEN_PLAN_WORK_NUDGE);
      emitTurnCompleted(s, s.iterations, turn.usage);
      return null;
    }

    if (openPlanWork) {
      noteLimit(s, limitMessage('limit.plan', 'Open plan todos remain'));
      emitTurnCompleted(s, s.iterations, turn.usage);
      emit?.({
        type: 'run.completed',
        runId,
        iterations: s.iterations,
        toolCalls: s.totalToolCalls,
        incomplete: true,
        ...(s.lastLimitReason ? { limitReason: s.lastLimitReason } : {}),
      });
      return {
        runId,
        content: result,
        iterations: s.iterations,
        toolCalls: s.totalToolCalls,
        status: 'incomplete',
        ...(s.lastLimitReason ? { limitReason: s.lastLimitReason } : {}),
      };
    }

    emitTurnCompleted(s, s.iterations, turn.usage);
    emit?.({
      type: 'run.completed',
      runId,
      iterations: s.iterations,
      toolCalls: s.totalToolCalls,
    });

    return {
      runId,
      content: result,
      iterations: s.iterations,
      toolCalls: s.totalToolCalls,
      status: 'completed',
    };
  }

  noteLimit(
    s,
    limitMessage(
      'limit.finish',
      `unexpected finish reason: ${turn.finishReason}`,
    ),
  );
  emitTurnCompleted(s, s.iterations, turn.usage);
  emit?.({
    type: 'run.completed',
    runId,
    iterations: s.iterations,
    toolCalls: s.totalToolCalls,
    incomplete: true,
    ...(s.lastLimitReason ? { limitReason: s.lastLimitReason } : {}),
  });

  return {
    runId,
    content: turn.content ?? '',
    iterations: s.iterations,
    toolCalls: s.totalToolCalls,
    status: 'incomplete',
    ...(s.lastLimitReason ? { limitReason: s.lastLimitReason } : {}),
  };
}
