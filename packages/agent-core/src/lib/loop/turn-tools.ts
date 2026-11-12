import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';

import {
  CHARS_PER_TOKEN,
  ChoiceSkipped,
  isAskStrippedTool,
  isReadOnlyPosture,
  limitMessage,
  type ModelTurn,
  type ToolContext,
  type ToolStage,
} from '@agent/agent-models';

import { estimatePromptTokens } from '../model/estimate-prompt-tokens';
import type { Tool } from '../tools/types';
import { isEditSuccess } from '../tools/workspace/tools';
import { outcomeKey, pathFromToolArgs, toolCallKey } from './call-identity';
import { manageResidency } from './residency-pass';
import { isCheckCommand } from '../state/task-state';
import { SERIAL_READ_ADVICE_AFTER } from './state-card';
import {
  emitTurnCompleted,
  noteLimit,
  toolArgsPreview,
  toolStage,
  type CoreResult,
  type RunState,
} from './run-state';
import { maybeSteerProgress, maybeSuggestAdvisor, maybeWarnBudget } from './steering-notes';
import { throwIfAborted, withTimeout } from './timeout';
import { preview } from './tool-call-record';
import {
  completeAfterDeferredChoice,
  completeAfterLimit,
  finishRequestedStop,
} from './turn-finish';

const USER_SKIPPED_CHOICE =
  'User skipped this choice to decide later. Do not pick an option or continue work that depends on it.';

/**
 * Cap for `tool.completed` result previews carried on the live event stream.
 * Large enough to carry a full read_file / run_terminal result for the UI's
 * inline preview; the host ledger still holds the unbounded result. Short
 * status strings (blocked, USER_SKIPPED_CHOICE) keep their own smaller caps.
 */
const RESULT_PREVIEW_MAX = 20_000;

/** Consecutive single-read turns between batching hints. */
const SERIAL_READ_NOTE_EVERY = SERIAL_READ_ADVICE_AFTER;

const SKIP_LIMIT_REACHED = limitMessage(
  'limit.tools',
  'Skipped: tool call limit reached.',
);
const REPEAT_BLOCKED = limitMessage(
  'limit.repeat',
  'This exact tool call has already been attempted multiple times. Do not repeat it.',
);

/** Answer to a repeated read or fetch: points at the result already made. */
function repeatAnswered(earlier: number): string {
  return `Not run again: this exact call already ran ${earlier} time(s) in this run with the same arguments, and its result has not changed. Use the earlier result: it is above, or an (evicted) card whose sha \`recall\` restores. Ask something different if you need more.`;
}

type ReadyToolCall = {
  toolCall: ChatCompletionMessageToolCall;
  toolName: string;
  tool: Tool;
  args: Record<string, unknown>;
};

type AdmitResult =
  | { kind: 'ready'; call: ReadyToolCall }
  | { kind: 'filled' }
  | {
      kind: 'halt';
      reason: 'limit' | 'repeat';
      toolCall: ChatCompletionMessageToolCall;
    };

type BatchOutcome = 'ok' | 'deferred' | 'halted';

/**
 * Every few turns in a row that each made one read call, say what that
 * costs: each turn re-sends the whole prompt, and read-stage calls of one
 * turn run in parallel. Shows the per-call size so the model can weigh it.
 */
function withSerialReadNote(s: RunState, toolName: string, result: string): string {
  if (!s.serialReadNoteDue) return result;
  s.serialReadNoteDue = false;
  const perCall = estimatePromptTokens(s.messages, s.tools.definitions);
  s.trace({
    type: 'tool_note',
    runId: s.runId,
    iteration: s.iterations,
    toolName,
    note: 'serial_reads',
    count: s.serialReadTurns,
  });
  if (s.flags.stateCard) return result;
  return `${result}\n\n(note) ${s.serialReadTurns} turns in a row each made one read call, and every turn re-sends ~${Math.round(perCall / 1000)}k tokens of context. Put independent reads and searches in one turn; they run in parallel.`;
}

/** Every few in-order slices of one web source, point at query (or explore). */
function withWebSliceNote(
  s: RunState,
  args: Record<string, unknown>,
  result: string,
): string {
  const count = s.webSources.sliceNoteDue(args, result);
  if (count === undefined) return result;
  s.trace({
    type: 'tool_note',
    runId: s.runId,
    iteration: s.iterations,
    toolName: 'web_fetch',
    note: 'web_slices',
    count,
  });
  const delegate = s.tools.byName.has('delegate')
    ? ', or delegate(explore) to read a long source for you'
    : '';
  return `${result}\n\n(note) ${count} slices of this source read in order; every slice stays in context. Use query="…" to jump to what you need${delegate}.`;
}

/** Per-tool result shaping before the result joins the prompt and ledger. */
function shapeToolResult(
  s: RunState,
  toolName: string,
  args: Record<string, unknown>,
  raw: string,
  toolCallId: string,
): string {
  // Notes go on last: read dedupe hashes the bare result. The serial-reads
  // note is only due on a turn whose single call is a read-stage tool.
  return withSerialReadNote(s, toolName, shapeBareResult(s, toolName, args, raw, toolCallId));
}

function shapeBareResult(
  s: RunState,
  toolName: string,
  args: Record<string, unknown>,
  raw: string,
  toolCallId: string,
): string {
  const cap = s.tools.byName.get(toolName)?.outputCap;
  const result =
    cap !== undefined && raw.length > cap
      ? `${raw.slice(0, cap)}\n\n(${toolName} output capped at ${cap} chars)`
      : raw;
  if (toolName === 'read_file') {
    const readPath = pathFromToolArgs(args);
    if (readPath === null) return result;
    const shaped = s.readDedupe.apply(readPath, args, result, s.iterations, toolCallId);
    // The same text was removed earlier and the model paid a step to get it
    // back: measured, so the working-set pricing can be judged.
    if (shaped.restored) {
      s.trace({ type: 'context_restored', runId: s.runId, iteration: s.iterations, toolCallId, path: readPath });
    }
    return shaped.text;
  }
  if (toolName === 'grep' || toolName === 'glob') {
    return s.readDedupe.applySearch(toolName, args, result, s.iterations, toolCallId);
  }
  if (toolName === 'web_fetch') {
    return withWebSliceNote(s, args, result);
  }
  if (toolName === 'load_skill' && !result.startsWith('Skill not found')) {
    const name = String(args.skill_name ?? '').trim();
    s.skillLoads.set(toolCallId, { name, iteration: s.iterations });
    s.trace({
      type: 'skill_loaded',
      runId: s.runId,
      iteration: s.iterations,
      name,
      ...(typeof args.section === 'string' ? { section: args.section } : {}),
      tokens: Math.ceil(result.length / CHARS_PER_TOKEN),
      source: 'model',
    });
    return result;
  }
  if (toolName === 'edit_file' && isEditSuccess(result)) {
    const editPath = pathFromToolArgs(args);
    if (editPath !== null) s.readDedupe.invalidatePath(editPath);
  } else if (toolName === 'run_terminal') {
    s.readDedupe.clear();
  }
  return result;
}

/**
 * The parent's messages for an advisor fork: everything up to (not
 * including) the assistant turn whose tool calls are still running, so
 * the fork is a valid conversation with the parent's exact prefix.
 */
function forkMessages(s: RunState): ChatCompletionMessageParam[] {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const message = s.messages[i];
    if (message?.role === 'assistant' && message.tool_calls?.length) {
      return s.messages.slice(0, i);
    }
  }
  return [...s.messages];
}

/** `toolCallId`: the call this context runs, so web trust lands on its row. */
function buildToolContext(s: RunState, toolCallId?: string): ToolContext {
  const { config, tools, signal, webSources } = s;
  const trustOf = (id: string) => {
    let trust = s.trustByCall.get(id);
    if (!trust) s.trustByCall.set(id, (trust = { urls: [], sources: [] }));
    return trust;
  };
  return {
    runId: s.runId,
    threadId: s.threadId,
    origin: s.origin,
    signal: signal ?? new AbortController().signal,
    ...(config.workspaceRoot !== undefined
      ? { workspaceRoot: config.workspaceRoot }
      : {}),
    ...(config.offerChoice ? { offerChoice: config.offerChoice } : {}),
    ...(config.subagents && tools.byName.has('delegate')
      ? {
          spawnSubagent: (spec) =>
            config.subagents!(spec, {
              runId: s.runId,
              threadId: s.threadId,
              model: config.model,
              depth: config.depth ?? 0,
              posture: s.posture,
              signal: signal ?? new AbortController().signal,
              ...(config.workspaceRoot !== undefined
                ? { workspaceRoot: config.workspaceRoot }
                : {}),
              toolNames: [...tools.byName.keys()],
              contextBudget: s.contextBudget,
              flags: s.flags,
              remainingPromptTokens: s.budget.remaining(),
              forkMessages: () => forkMessages(s),
              webTrust: () => webSources.snapshot(),
              ...(config.emit ? { emit: config.emit } : {}),
              ...(config.pinnedSkills ? { pinnedSkills: config.pinnedSkills } : {}),
              ...(config.recordCalls ? { recordCalls: true } : {}),
              ...(config.capacity ? { capacity: config.capacity } : {}),
              chargeUsage: (child) => s.budget.chargeChild(child),
            }),
        }
      : {}),
    requestStop: (content) => {
      s.stopContent = content;
    },
    putBlob: (text) => webSources.putBlob(text),
    readBlob: (sha, offset, length) => webSources.readBlob(sha, offset, length),
    noteTrustedWebUrls: (urls) => {
      webSources.noteTrustedUrls(urls);
      if (toolCallId) trustOf(toolCallId).urls.push(...urls);
    },
    noteWebSource: (source) => {
      webSources.noteSource(source);
      if (toolCallId) {
        trustOf(toolCallId).sources.push({
          sha256: source.sha256,
          url: source.url,
          title: source.title,
        });
      }
    },
    getWebSource: (sha) => webSources.get(sha),
    getWebSourceByUrl: (url) => webSources.getByUrl(url),
    trustsWebUrl: (url) => webSources.trustsUrl(url),
    trustsWebSha: (sha) => webSources.trustsSha(sha),
    trace: s.trace,
  };
}

async function admitToolCall(
  s: RunState,
  toolCall: ChatCompletionMessageToolCall,
): Promise<AdmitResult> {
  const { record, guard, steering, limits, tools } = s;
  // Rejects always get a tool row (I1) but do not burn maxToolCalls (D10).
  if (toolCall.type !== 'function') {
    await record.refuse(toolCall, 'Unsupported tool call type.');
    return { kind: 'filled' };
  }

  const toolName = toolCall.function.name;
  const tool = tools.byName.get(toolName);

  if (!tool) {
    await record.refuse(toolCall, `Tool "${toolName}" does not exist.`);
    const streakLimit = guard.unknownTool();
    if (streakLimit) {
      noteLimit(s, streakLimit);
      return { kind: 'halt', reason: 'limit', toolCall };
    }
    return { kind: 'filled' };
  }

  guard.knownTool();

  if (isReadOnlyPosture(s.posture) && isAskStrippedTool(toolName)) {
    await record.refuse(
      toolCall,
      s.posture === 'plan'
        ? 'Blocked: this run is Plan (read-only). Finish the plan; the user switches to Agent to carry it out.'
        : 'Blocked: this run is Ask (read-only). Switch the composer to Agent to edit files or run commands.',
    );
    return { kind: 'filled' };
  }

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch {
    await record.refuse(toolCall, 'Invalid tool arguments. Expected valid JSON.');
    return { kind: 'filled' };
  }

  const refusal = tool.admit?.(args, buildToolContext(s));
  if (refusal) {
    await record.refuse(toolCall, refusal);
    return { kind: 'filled' };
  }

  // Research gate: after half the budget with no edit or sub-agent report,
  // the parent's own web tools close until progress. A refusal row, not a
  // halt: reads, edits and delegate(explore) still work.
  if (tool.research && steering.researchGated()) {
    const idle = steering.idleTokens();
    const delegate = tools.byName.has('delegate')
      ? ' If one specific fact is still missing, delegate(explore) with that question.'
      : '';
    if (steering.noteGated()) {
      s.trace({
        type: 'research_gate',
        runId: s.runId,
        iteration: s.iterations,
        toolName,
        idleTokens: idle,
      });
    }
    await record.refuse(
      toolCall,
      limitMessage(
        'limit.research',
        `Web research is paused for this run: ${Math.round((idle / limits.maxPromptTokens!) * 100)}% of the budget went to steps with no edit. It reopens after your next edit or sub-agent report. Use what you have.${delegate}`,
      ),
    );
    return { kind: 'filled' };
  }

  const readPath =
    toolName === 'read_file' ? pathFromToolArgs(args) : null;
  const stormLimit =
    (readPath !== null ? guard.readStorm(readPath) : null) ??
    (toolName === 'run_terminal' ? guard.terminalStorm() : null);
  if (stormLimit) {
    noteLimit(s, stormLimit);
    return { kind: 'halt', reason: 'limit', toolCall };
  }

  if (
    limits.maxToolCalls !== undefined &&
    s.totalToolCalls >= limits.maxToolCalls
  ) {
    noteLimit(
      s,
      limitMessage(
        'limit.tools',
        `max tool calls exceeded (${limits.maxToolCalls})`,
      ),
    );
    return { kind: 'halt', reason: 'limit', toolCall };
  }

  const repeatCount = guard.countCall(toolCallKey(toolName, args));

  // Exec tools (run_terminal) are exempt from the arg-repeat guard: re-running
  // the same build after an edit is legitimate verification, and outcome dedup
  // (MAX_IDENTICAL_OUTCOMES) catches true stuck-ness. The arg-repeat guard
  // stays for mutate/read/network/skill.
  const stage = toolStage(tool);
  // Reads and web fetches change nothing, so a repeat is answered instead of
  // ending the run: the earlier result is still in context or restorable
  // from its card's sha. Only a call that keeps coming back past twice the
  // limit stops the run (a model in a loop).
  if (
    repeatCount > limits.maxRepeatedToolCalls &&
    repeatCount <= limits.maxRepeatedToolCalls * 2 &&
    (stage === 'read' || stage === 'network')
  ) {
    await record.refuse(toolCall, repeatAnswered(repeatCount - 1));
    s.trace({
      type: 'policy_decision',
      runId: s.runId,
      iteration: s.iterations,
      kind: 'guard',
      ids: [`repeat_answered:${toolName}`],
    });
    return { kind: 'filled' };
  }
  if (
    repeatCount > limits.maxRepeatedToolCalls &&
    stage !== 'exec'
  ) {
    noteLimit(
      s,
      limitMessage('limit.repeat', `repeated tool call blocked: ${toolName}`),
    );
    return { kind: 'halt', reason: 'repeat', toolCall };
  }

  s.totalToolCalls += 1;
  guard.admitted(toolName, readPath);

  return {
    kind: 'ready',
    call: { toolCall, toolName, tool, args },
  };
}

async function finishHalt(
  s: RunState,
  halt: Extract<AdmitResult, { kind: 'halt' }>,
  fromIndex: number,
  toolCalls: ChatCompletionMessageToolCall[],
): Promise<CoreResult> {
  const triggerAnswered = s.record.isAnswered(halt.toolCall.id);
  if (halt.reason === 'repeat') {
    if (!triggerAnswered) await s.record.refuse(halt.toolCall, REPEAT_BLOCKED);
    await s.record.skip(toolCalls.slice(fromIndex + 1), SKIP_LIMIT_REACHED);
  } else if (triggerAnswered) {
    await s.record.skip(toolCalls.slice(fromIndex + 1), SKIP_LIMIT_REACHED);
  } else {
    await s.record.skip(toolCalls.slice(fromIndex), SKIP_LIMIT_REACHED);
  }
  return completeAfterLimit(s);
}

function startCall(s: RunState, call: ReadyToolCall): void {
  s.trace({
    type: 'tool_start',
    runId: s.runId,
    iteration: s.iterations,
    toolName: call.toolName,
    toolCallId: call.toolCall.id,
    stage: toolStage(call.tool),
    args: call.args,
  });
  s.record.start(
    call.toolCall.id,
    call.toolName,
    toolArgsPreview(call.tool, call.args),
  );
}

/** A tool that owns its timeout (exec tools always do) is not raced by the loop's, which would leak its child. */
function runTool(s: RunState, call: ReadyToolCall, toolCtx: ToolContext): Promise<string> {
  const ownsTimeout = call.tool.ownsTimeout === true || call.tool.risk === 'exec';
  return withTimeout(
    call.tool.execute(call.args, toolCtx),
    ownsTimeout ? 0 : s.limits.toolTimeoutMs,
    s.signal,
  );
}

/** A call returned: record it, then the stuck guard and edit progress. */
async function settleReturned(
  s: RunState,
  call: ReadyToolCall,
  result: string,
  resultChars: number,
  durationMs: number,
): Promise<'ok' | 'halted'> {
  const { toolCall, toolName, tool, args } = call;
  const classified = tool.classify?.(result);
  s.trace({
    type: 'tool_complete',
    runId: s.runId,
    iteration: s.iterations,
    toolName,
    toolCallId: toolCall.id,
    durationMs,
    resultPreview: preview(result),
    resultChars,
    ...(classified ? { outcome: classified.outcome } : {}),
    ...(classified?.exitCode !== undefined ? { exitCode: classified.exitCode } : {}),
  });
  // Append before outcome halt so I1 always holds for the triggering call.
  const webTrust = s.trustByCall.get(toolCall.id);
  s.trustByCall.delete(toolCall.id);
  await s.record.complete(
    toolCall.id,
    toolName,
    result,
    durationMs,
    preview(result, RESULT_PREVIEW_MAX),
    webTrust ? { webTrust } : {},
  );
  // Mutate + exec: same call + same result = stuck (e.g. write theater,
  // or run_terminal producing the same exit code with no edit between).
  const stage = toolStage(tool);
  if (stage === 'mutate' || stage === 'exec') {
    const outcome = s.guard.recordOutcome(
      outcomeKey(toolName, args, result),
      stage === 'exec',
    );
    if (outcome.nearStuck) maybeSuggestAdvisor(s);
    if (outcome.stuck) {
      noteLimit(
        s,
        limitMessage(
          'limit.outcome',
          `repeated identical tool outcome blocked: ${toolName}`,
        ),
      );
      return 'halted';
    }
  }
  // A successful edit_file is progress: prior exec outcomes (build/lint
  // exits) are now stale. Clear them so the next verification cycle starts
  // fresh instead of accumulating toward a false stuck-ness halt.
  if (toolName === 'edit_file' && isEditSuccess(result)) {
    s.guard.editSucceeded();
    s.steering.markProgress();
  }
  // Other evidence is progress too: a recorded finding (research), and a
  // project check that passed. Stall advice counts from the last evidence.
  const passingCheck =
    toolName === 'run_terminal' &&
    classified?.exitCode === 0 &&
    isCheckCommand(typeof args.command === 'string' ? args.command : '');
  if ((toolName === 'record_finding' && result.startsWith('Recorded')) || passingCheck) {
    s.steering.markProgress();
  }
  return 'ok';
}

async function settleThrown(s: RunState, call: ReadyToolCall, error: unknown): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : String(error);
  s.trace({
    type: 'tool_error',
    runId: s.runId,
    iteration: s.iterations,
    toolName: call.toolName,
    toolCallId: call.toolCall.id,
    error: errorMessage,
  });
  await s.record.fail(call.toolCall.id, errorMessage);
}

async function executeReadyCall(
  s: RunState,
  call: ReadyToolCall,
  remainingOnAbort: ChatCompletionMessageToolCall[],
): Promise<BatchOutcome> {
  startCall(s, call);
  const startedAt = Date.now();
  try {
    const raw = await runTool(s, call, buildToolContext(s, call.toolCall.id));
    const result = shapeToolResult(s, call.toolName, call.args, raw, call.toolCall.id);
    return await settleReturned(s, call, result, raw.length, Date.now() - startedAt);
  } catch (error) {
    if (s.signal?.aborted) {
      await s.record.skip(remainingOnAbort, 'Skipped: run cancelled.');
      throwIfAborted(s.signal);
    }
    if (error instanceof ChoiceSkipped) {
      await s.record.complete(
        call.toolCall.id,
        call.toolName,
        USER_SKIPPED_CHOICE,
        Date.now() - startedAt,
        preview(USER_SKIPPED_CHOICE, 200),
        { outcome: 'skipped' },
      );
      await s.record.skip(
        remainingOnAbort.slice(1),
        'Skipped: user deferred this choice.',
      );
      return 'deferred';
    }
    await settleThrown(s, call, error);
    return 'ok';
  }
}

async function executeReadyBatch(
  s: RunState,
  batch: ReadyToolCall[],
  remainingAfter: ChatCompletionMessageToolCall[],
): Promise<BatchOutcome> {
  // write/exec tools stay serial even if they slip into a parallel stage.
  if (
    batch.length === 1 ||
    batch.some((call) => call.tool.risk === 'write' || call.tool.risk === 'exec')
  ) {
    for (let i = 0; i < batch.length; i++) {
      const call = batch[i];
      if (!call) continue;
      const outcome = await executeReadyCall(s, call, [
        ...batch.slice(i).map((item) => item.toolCall),
        ...remainingAfter,
      ]);
      if (outcome !== 'ok') return outcome;
    }
    return 'ok';
  }

  for (const call of batch) startCall(s, call);

  const settled = await Promise.all(
    batch.map(async (call) => {
      const started = Date.now();
      try {
        const raw = await runTool(s, call, buildToolContext(s, call.toolCall.id));
        return {
          call,
          ok: true as const,
          result: shapeToolResult(s, call.toolName, call.args, raw, call.toolCall.id),
          resultChars: raw.length,
          durationMs: Date.now() - started,
        };
      } catch (error) {
        return { call, ok: false as const, error };
      }
    }),
  );

  // A cancel discards results already back: the run is ending anyway.
  if (s.signal?.aborted) {
    await s.record.skip(
      [...batch.map((call) => call.toolCall), ...remainingAfter],
      'Skipped: run cancelled.',
    );
    throwIfAborted(s.signal);
  }

  // Record every call before returning halted, so the batch stays whole.
  let outcomeHalted = false;
  for (const item of settled) {
    if (item.ok) {
      const outcome = await settleReturned(
        s,
        item.call,
        item.result,
        item.resultChars,
        item.durationMs,
      );
      if (outcome === 'halted') outcomeHalted = true;
    } else {
      await settleThrown(s, item.call, item.error);
    }
  }
  return outcomeHalted ? 'halted' : 'ok';
}

async function runSerial(s: RunState, batch: ReadyToolCall[]): Promise<BatchOutcome> {
  for (let i = 0; i < batch.length; i++) {
    const call = batch[i];
    if (!call) continue;
    const outcome = await executeReadyCall(
      s,
      call,
      batch.slice(i).map((item) => item.toolCall),
    );
    if (outcome !== 'ok') return outcome;
  }
  return 'ok';
}

/**
 * Run one model turn's tool calls: admit each through the gates, run them in
 * stages, then shrink the prompt and add any steering notes. Returns the
 * run's result when this turn ends it, or null to take another model turn.
 */
export async function runToolTurn(
  s: RunState,
  turn: ModelTurn,
): Promise<CoreResult | null> {
  const ready: ReadyToolCall[] = [];
  let halt: Extract<AdmitResult, { kind: 'halt' }> | null = null;
  let haltIndex = 0;
  s.steering.startTurn();
  for (let index = 0; index < turn.toolCalls.length; index++) {
    if (s.signal?.aborted) {
      await s.record.skip(
        turn.toolCalls.slice(index),
        'Skipped: run cancelled.',
      );
      throwIfAborted(s.signal);
    }

    const toolCall = turn.toolCalls[index];
    if (!toolCall) continue;

    const admitted = await admitToolCall(s, toolCall);
    if (admitted.kind === 'halt') {
      halt = admitted;
      haltIndex = index;
      break;
    }
    if (admitted.kind === 'filled') continue;
    ready.push(admitted.call);
  }

  // A model that only retries closed web tools spends a full call per
  // refusal; after MAX_GATED_TURNS such turns, end with a handoff.
  const gatedStreak = s.steering.endTurn(halt !== null, turn.toolCalls.length);
  if (gatedStreak !== null) {
    noteLimit(
      s,
      limitMessage(
        'limit.research',
        `${gatedStreak} turns in a row only retried closed web tools`,
      ),
    );
    return await completeAfterLimit(s);
  }

  const staged: Record<ToolStage, ReadyToolCall[]> = {
    skill: [],
    read: [],
    network: [],
    subagent: [],
    exec: [],
    mutate: [],
  };
  for (const call of ready) {
    staged[toolStage(call.tool)].push(call);
  }
  const singleRead =
    turn.toolCalls.length === 1 && ready.length === 1 && staged.read.length === 1;
  s.serialReadTurns = singleRead ? s.serialReadTurns + 1 : 0;
  s.serialReadNoteDue = singleRead && s.serialReadTurns % SERIAL_READ_NOTE_EVERY === 0;

  // I4 staging: skill → read → network → exec → mutate → subagent.
  // skill, read, and subagent run parallel (executeReadyBatch);
  // network, exec, mutate run serial (one at a time within stage).
  // Sub-agents go last so a review in the same turn sees this turn's edits.
  // Abort only on deferred|halted — never short-circuit on truthy 'ok'.
  let batchOutcome: BatchOutcome = 'ok';
  for (const stageBatch of [staged.skill, staged.read] as const) {
    batchOutcome = await executeReadyBatch(s, stageBatch, []);
    if (batchOutcome !== 'ok') break;
  }
  if (batchOutcome === 'ok') {
    for (const stageBatch of [
      staged.network,
      staged.exec,
      staged.mutate,
    ] as const) {
      batchOutcome = await runSerial(s, stageBatch);
      if (batchOutcome !== 'ok') break;
    }
  }
  if (batchOutcome === 'ok') {
    batchOutcome = await executeReadyBatch(s, staged.subagent, []);
  }
  if (batchOutcome === 'deferred') {
    // Calls in later stages (e.g. a delegate after offer_choice) never ran:
    // answer them before the summary call, so no tool_call goes unanswered.
    await s.record.skip(turn.toolCalls, 'Skipped: user deferred this choice.');
    return await completeAfterDeferredChoice(s);
  }
  if (batchOutcome === 'halted') {
    const skipDetail = s.lastLimitReason?.startsWith('limit.outcome:')
      ? limitMessage('limit.outcome', 'Skipped: tool call limit reached.')
      : SKIP_LIMIT_REACHED;
    await s.record.skip(turn.toolCalls, skipDetail);
    return await completeAfterLimit(s);
  }
  if (halt) {
    return await finishHalt(s, halt, haltIndex, turn.toolCalls);
  }
  if (s.stopContent !== undefined) {
    return await finishRequestedStop(s, s.stopContent, turn.usage);
  }

  await manageResidency(s);
  maybeSteerProgress(s);
  maybeWarnBudget(s);
  emitTurnCompleted(s, s.iterations, turn.usage);
  return null;
}
