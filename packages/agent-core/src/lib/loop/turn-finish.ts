import { randomUUID } from 'node:crypto';

import {
  limitMessage,
  REPORT_MAX_CHARS,
  type ModelTurn,
  type TokenUsage,
} from '@agent/agent-models';

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
import { changeGate, planGate } from '../policy';
import { measureContextShape } from './context-shape';
import { tracePolicyDecision } from './policy-trace';
import { OPEN_PLAN_WORK_NUDGE } from './steering-notes';
import { preview } from './tool-call-record';

/** Tools-off final call after a limit; doubles as the handoff the next run continues from. */
const LIMIT_HANDOFF_INSTRUCTION =
  'This run stopped at a limit; tools are off. If the request can be answered from the information above, answer it now and say what is uncertain. Otherwise write a short handoff for the next run: what is done (files changed, what was verified), what is left, and the exact next step.';

/**
 * The same handoff for a sub-agent (a run with a `report` tool): its answer
 * becomes the report the parent reads, so it asks for the report's shape
 * and size, with the gaps first-class.
 */
const REPORT_LIMIT_HANDOFF_INSTRUCTION = `This run stopped at a limit; tools are off and \`report\` can no longer be called. Write your report as plain text now, under ${REPORT_MAX_CHARS.toLocaleString('en-US')} characters in total (the parent reads that much; text past it is cut). Use this shape: 1) Status: partial, plus one line on where you stopped; 2) Findings: one line each with path:line evidence; 3) Open: what you could not find or verify and the exact next search. List the gaps even if the findings are short. No preamble, no repeated tool output.`;

/** Tools-off final call after the user skipped an offer_choice: a summary they can decide from. */
const DEFERRED_CHOICE_INSTRUCTION =
  'The user skipped your question to decide later; tools are off. Do not pick an option or continue the work. Write the reply they will decide from: 1) one or two lines on what was done so far and where it stopped; 2) the open question; 3) each option by its label: what it would do, its trade-offs (effort, risk, what it changes) and when it is the right pick; 4) your recommendation and why; 5) how to answer next time (for example "Go with <label>", several options, or other direction). Keep it scannable.';

const STOP_CHECK_NOTE =
  'Your answer reports success, but no check (build, typecheck, test or lint) has run since your last edit. Run the project check now, or say plainly what is not verified.';

/** The change done gate (policy/finish changeGate) over this run's state. */
function needsStopCheck(s: RunState, answer: string): boolean {
  return changeGate({
    enabled: s.flags.stopCheck,
    alreadySent: s.stopChecked,
    posture: s.posture,
    unchecked: s.task.unchecked,
    canRunChecks: s.tools.byName.has('run_terminal'),
    answer,
  });
}

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
  // Measured like every other call, so a run that ends on a limit has no
  // unmeasured last call.
  const measured = measureContextShape(s.messages, s.runStart, s.promptKeys);
  s.promptKeys = measured.keys;
  s.trace({ type: 'context_shape', runId, iteration: s.iterations, ...measured.shape });
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
    { durationMs, runDurationMs: Date.now() - s.runStartedAt, messageId: finalMessageId },
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
  const final = await finalizeAnswer(
    s,
    s.tools.byName.has('report') ? REPORT_LIMIT_HANDOFF_INSTRUCTION : LIMIT_HANDOFF_INSTRUCTION,
  );
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
    { durationMs, runDurationMs: Date.now() - s.runStartedAt, messageId },
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
    if (needsStopCheck(s, result)) {
      s.stopChecked = true;
      pushHarnessNote(s, STOP_CHECK_NOTE);
      s.trace({ type: 'stop_check', runId, iteration: s.iterations });
      tracePolicyDecision(s, 'finish', ['done_gate:unchecked'], 'claims success with edits not followed by a check');
      emitTurnCompleted(s, s.iterations, turn.usage);
      return null;
    }
    const openPlanWork = s.config.hasOpenPlanWork
      ? await s.config.hasOpenPlanWork()
      : false;

    const plan = planGate({ openPlanWork, nudges: s.planWorkNudges });
    if (plan === 'nudge') {
      s.planWorkNudges += 1;
      pushHarnessNote(s, OPEN_PLAN_WORK_NUDGE);
      tracePolicyDecision(s, 'finish', ['done_gate:open_plan'], 'open todos remain on the plan');
      emitTurnCompleted(s, s.iterations, turn.usage);
      return null;
    }

    if (plan === 'stop') {
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
