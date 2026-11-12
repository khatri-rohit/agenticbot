import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';

import { CHARS_PER_TOKEN, type ContextBudget } from '@agent/agent-models';

import { estimatePromptTokens } from '../model/estimate-prompt-tokens';
import { skillCard } from '../tools/skills';
import { sha256Text } from '../tools/web/source';
import { argsPreview, toolCallIndex, type ToolCallInfo } from './outcome-card';

/**
 * In-run context residency. assembleContext evicts by user turn when a run
 * starts; inside one long run every iteration re-sends every resident tool
 * result. These passes keep a long run's prompt to its working set without
 * an LLM call: superseded and cold results become cards (task state says
 * what is in use), applied skill bodies retire to their core rules, old
 * iterations fold into a recap (at a size mark, or at a verified
 * milestone), and unchanged re-reads are answered with a pointer.
 */

/** Tool results smaller than this are not worth a card. */
const MIN_EVICT_CHARS = 800;
/**
 * Live state the generic pass never evicts. load_skill bodies leave through
 * retireSkillBodies instead, which keeps their core rules.
 */
const NEVER_EVICT = new Set(['plan', 'todo', 'load_skill']);
/** Text a removed tool result starts with. */
export const CARD_PREFIX = '(evicted)';
const SKILL_CARD_PREFIX = '(skill card)';
const UNCHANGED_PREFIX = '(unchanged';
const RECAP_PREFIX = '(compacted progress)';
const RECAP_MAX_CHARS = 8_000;

function isResident(content: string): boolean {
  return (
    !content.startsWith(CARD_PREFIX) &&
    !content.startsWith(SKILL_CARD_PREFIX) &&
    !content.startsWith('(stub)') &&
    !content.startsWith(UNCHANGED_PREFIX)
  );
}

/** edit_file reports keep their header (path, line/byte delta); the hunk goes. */
function editCard(content: string): string {
  const header = content.split('\n\n')[0] ?? content;
  return `${header}\n(hunk evicted)`;
}

/** Tool call arguments as an object; malformed JSON reads as no arguments. */
function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** A run_terminal result from a command that executed (see outcome-card). */
function terminalRan(content: string): boolean {
  const [first = '', second = ''] = content.split('\n', 2);
  return first.startsWith('cwd:') && /^(exit|signal) /.test(second.trim());
}

/** Lines a read_file result shows, from its `[lines a–b of N]` header. */
function readRange(content: string): { from: number; to: number } | null {
  const match = /^\[lines (\d+)–(\d+) of /.exec(content);
  return match ? { from: Number(match[1]), to: Number(match[2]) } : null;
}

/**
 * Paths whose latest read_file result is still resident in full in the
 * prompt (not a card, stub or unchanged-pointer). The harness card lists
 * only these, so it never claims content the model can no longer see.
 */
export function residentReadPaths(
  messages: ChatCompletionMessageParam[],
  pathOf: (args: Record<string, unknown>) => string | null,
): Set<string> {
  const calls = toolCallIndex(messages);
  const latest = new Map<string, boolean>();
  for (const message of messages) {
    if (message.role !== 'tool' || typeof message.content !== 'string') continue;
    const info = calls.get(message.tool_call_id);
    if (info?.name !== 'read_file') continue;
    const path = pathOf(parseArgs(info.args));
    if (path) latest.set(path, isResident(message.content));
  }
  return new Set([...latest].filter(([, resident]) => resident).map(([path]) => path));
}

export type EvictionReason = 'superseded' | 'cold' | 'cited' | 'budget';

/** Sub-agent report shas named in delegate results (`reportSha=<sha>` in the header). */
function reportShas(messages: ChatCompletionMessageParam[], calls: Map<string, ToolCallInfo>): Set<string> {
  const shas = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'tool' || typeof message.content !== 'string') continue;
    if (calls.get(message.tool_call_id)?.name !== 'delegate') continue;
    for (const match of message.content.matchAll(/reportSha=([a-f0-9]{64})/g)) shas.add(match[1]!);
  }
  return shas;
}

/**
 * A result that cost a sub-agent run to produce: a delegate report, or a
 * recall of one. Getting it back would mean running the child again, so it
 * is never removed to save tokens (it is small next to what it stands for).
 */
function isReport(info: ToolCallInfo | undefined, args: Record<string, unknown>, shas: Set<string>): boolean {
  if (info?.name === 'delegate') return true;
  return info?.name === 'recall' && typeof args.sha256 === 'string' && shas.has(args.sha256.trim().toLowerCase());
}

export type EvictionResult = {
  evicted: number;
  beforeTokens: number;
  afterTokens: number;
  /** Tool calls whose results are no longer resident in full. */
  toolCallIds: string[];
  /** The same calls grouped by why they left. */
  byReason: Partial<Record<EvictionReason, string[]>>;
};

/**
 * What the working-set pass needs from the run's task state. Iterations are
 * loop iterations (model calls).
 */
export type WorkingSetView = {
  iteration: number;
  /** Iteration a tool call started in. */
  callIteration(toolCallId: string): number | undefined;
  /** Latest iteration a path was read or edited. */
  lastTouch(path: string): number | undefined;
  /** The path was edited since the last check: it is being changed, keep it. */
  isUnchecked(path: string): boolean;
  /** A recorded finding cites the path: the finding stands for its reads. */
  isCited?(path: string): boolean;
};

type Candidate = {
  index: number;
  toolCallId: string;
  info: ToolCallInfo | undefined;
  chars: number;
  /** Iteration of the latest use of this result (file touch, else its own call). */
  touch: number;
  path: string | null;
  superseded: boolean;
  cold: boolean;
  /** A recorded finding cites this result's file. */
  cited: boolean;
  /** Must stay: being changed, or this iteration's result. */
  pinned: boolean;
};

/**
 * What a removed result leaves: tool, arguments, why, size and the sha that
 * restores it. Short on purpose, because cards stay for the rest of the run;
 * how to restore is said once (recall's description, the system prompt).
 */
function workingSetCard(candidate: Candidate, content: string, sha: string, reason: EvictionReason): string {
  const name = candidate.info?.name ?? 'tool';
  const args = candidate.info ? ` ${argsPreview(candidate.info.args)}` : '';
  const range = name === 'read_file' ? readRange(content) : null;
  const lines = range ? ` [${range.from}–${range.to}]` : '';
  return `${CARD_PREFIX} ${name}${args}${lines} · ${reason} · ${content.length} chars · sha256:${sha}`;
}

/**
 * Keep this run's tool results to the working set (task state decides).
 * Results are priced: what it costs to get one back against what it costs
 * to keep sending it.
 * - superseded: a later resident read covers the same lines of the same
 *   file, or the same command ran again (only commands that executed count);
 * - cold: a file not read or edited for `inRunColdAfterIterations`, or any
 *   other result that old, except the newest `inRunKeepToolResults` non-file
 *   results;
 * - cited: a recorded finding cites the file, so the finding stands for it;
 * - budget: past `inRunResidentToolTokens` of resident results, cited
 *   results first, then least recently touched (larger first on a tie),
 *   down to the low mark (`inRunResidentLowRatio` of the cap) in one pass.
 * Never removed: a file edited since the last check, this iteration's
 * results, and sub-agent reports (and recalls of them), which would cost a
 * child run to get back. Edits never supersede reads (several edits from
 * one read are normal).
 *
 * Removal happens in passes, because each pass changes the cached prompt:
 * a pass runs when resident results pass the cap, or when stale (superseded,
 * cold, cited) results free at least `inRunClearAtLeastTokens`. A pass that
 * runs for the cap also takes the stale results. Between passes nothing
 * leaves. Every card keeps a sha for recall. Results from earlier turns are
 * only superseded (assembleContext already stubs them).
 */
export async function manageWorkingSet(
  messages: ChatCompletionMessageParam[],
  runStart: number,
  budget: ContextBudget,
  tools: ChatCompletionTool[],
  putBlob: (text: string) => Promise<string>,
  pathOf: (args: Record<string, unknown>) => string | null,
  view: WorkingSetView,
): Promise<EvictionResult | null> {
  const calls = toolCallIndex(messages);
  const shas = reportShas(messages, calls);
  // Reports are resident and count toward the cap, but never leave.
  let reportChars = 0;
  const laterReads = new Map<string, Array<{ from: number; to: number }>>();
  const laterCommands = new Set<string>();
  const candidates: Candidate[] = [];
  let nonFileSeen = 0;

  // Newest first: supersession compares each result with what came after it,
  // and the newest non-file results are counted as they are met.
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'tool' || typeof message.content !== 'string') continue;
    const content = message.content;
    if (!isResident(content)) continue;
    const info = calls.get(message.tool_call_id);
    if (info && NEVER_EVICT.has(info.name)) continue;
    const args = info ? parseArgs(info.args) : {};
    const inRun = i >= runStart;
    if (isReport(info, args, shas)) {
      if (inRun) reportChars += content.length;
      continue;
    }

    let superseded = false;
    let path: string | null = null;
    if (info?.name === 'read_file') {
      path = pathOf(args);
      const range = readRange(content);
      if (path && range) {
        const later = laterReads.get(path) ?? [];
        superseded = later.some((r) => r.from <= range.from && r.to >= range.to);
        if (!superseded) {
          later.push(range);
          laterReads.set(path, later);
        }
      }
    } else if (info?.name === 'run_terminal') {
      const command = typeof args.command === 'string' ? args.command.trim() : '';
      // A blocked, skipped or repeat-refused call must not card a real run.
      if (command && terminalRan(content)) {
        superseded = laterCommands.has(command);
        laterCommands.add(command);
      }
    }
    if (content.length < MIN_EVICT_CHARS) continue;
    if (!inRun && !superseded) continue;

    const own = view.callIteration(message.tool_call_id) ?? view.iteration;
    const touch = path ? Math.max(own, view.lastTouch(path) ?? own) : own;
    let cold = false;
    if (inRun && !superseded) {
      if (path) {
        cold = view.iteration - touch >= budget.inRunColdAfterIterations;
      } else {
        nonFileSeen += 1;
        cold =
          nonFileSeen > budget.inRunKeepToolResults &&
          view.iteration - own >= budget.inRunColdAfterIterations;
      }
    }
    const pinned = (path !== null && view.isUnchecked(path)) || own >= view.iteration;
    const cited = inRun && path !== null && view.isCited?.(path) === true;
    candidates.push({
      index: i,
      toolCallId: message.tool_call_id,
      info,
      chars: content.length,
      touch,
      path,
      superseded,
      cold: cold && !pinned,
      cited: cited && !pinned,
      pinned,
    });
  }

  // Stale results: superseded (even when pinned: the newer copy is
  // resident), cold, or stood for by a finding.
  const chosen = new Map<number, EvictionReason>();
  let staleChars = 0;
  for (const candidate of candidates) {
    const reason: EvictionReason | null = candidate.superseded
      ? 'superseded'
      : candidate.cold
        ? 'cold'
        : candidate.cited
          ? 'cited'
          : null;
    if (!reason) continue;
    chosen.set(candidate.index, reason);
    staleChars += candidate.chars - 250;
  }

  const highChars = budget.inRunResidentToolTokens * CHARS_PER_TOKEN;
  const lowChars = highChars * budget.inRunResidentLowRatio;
  const residentOf = () =>
    reportChars +
    candidates
      .filter((candidate) => candidate.index >= runStart && !chosen.has(candidate.index))
      .reduce((sum, candidate) => sum + candidate.chars, 0);
  const overCap = residentOf() > highChars;
  // No pass this step: stale results wait until they are worth a pass.
  if (!overCap && staleChars / CHARS_PER_TOKEN < budget.inRunClearAtLeastTokens) return null;

  if (overCap) {
    // Down to the low mark in one pass, so the next results fit without one.
    let residentChars = residentOf();
    const order = candidates
      .filter((candidate) => candidate.index >= runStart && !candidate.pinned && !chosen.has(candidate.index))
      .sort((a, b) => a.touch - b.touch || b.chars - a.chars || a.index - b.index);
    for (const candidate of order) {
      if (residentChars <= lowChars) break;
      chosen.set(candidate.index, 'budget');
      residentChars -= candidate.chars;
    }
  }
  if (chosen.size === 0) return null;

  const beforeTokens = estimatePromptTokens(messages, tools);
  const toolCallIds: string[] = [];
  const byReason: Partial<Record<EvictionReason, string[]>> = {};
  for (const candidate of candidates) {
    const reason = chosen.get(candidate.index);
    if (!reason) continue;
    const message = messages[candidate.index];
    if (message?.role !== 'tool' || typeof message.content !== 'string') continue;
    const content = message.content;
    const card =
      candidate.info?.name === 'edit_file'
        ? editCard(content)
        : workingSetCard(candidate, content, await putBlob(content), reason);
    messages[candidate.index] = { role: 'tool', tool_call_id: message.tool_call_id, content: card };
    toolCallIds.push(candidate.toolCallId);
    (byReason[reason] ??= []).push(candidate.toolCallId);
  }
  return {
    evicted: toolCallIds.length,
    beforeTokens,
    afterTokens: estimatePromptTokens(messages, tools),
    toolCallIds,
    byReason,
  };
}

/**
 * Turn applied skill bodies into skill cards (core rules + reload note).
 * Age-based, not size-based: a body is needed while the model plans and
 * starts the work, not for the rest of the run.
 */
export function retireSkillBodies(
  messages: ChatCompletionMessageParam[],
  loads: Map<string, { name: string; iteration: number }>,
  iteration: number,
  residentIterations: number,
): { toolCallId: string; name: string }[] {
  const retired: { toolCallId: string; name: string }[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message?.role !== 'tool' || typeof message.content !== 'string') continue;
    const load = loads.get(message.tool_call_id);
    if (!load || iteration - load.iteration < residentIterations) continue;
    if (!isResident(message.content)) continue;
    messages[i] = {
      role: 'tool',
      tool_call_id: message.tool_call_id,
      content: skillCard(load.name, load.iteration),
    };
    loads.delete(message.tool_call_id);
    retired.push({ toolCallId: message.tool_call_id, name: load.name });
  }
  return retired;
}

function textOf(content: ChatCompletionMessageParam['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
    .join('\n');
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * One line per tool outcome: what was done and what came back. `storedSha`
 * is the blob of a large resident result folded here, so it stays recallable.
 */
function outcomeLine(
  info: ToolCallInfo | undefined,
  content: string,
  storedSha?: string,
): string {
  const name = info?.name ?? 'tool';
  const args = info ? argsPreview(info.args) : '';
  const first = content.split('\n')[0] ?? '';
  let outcome: string;
  if (name === 'edit_file') {
    outcome = first;
  } else if (name === 'run_terminal') {
    const exit = content.split('\n').find((line) => /^(exit|signal) /.test(line));
    outcome = exit ?? first;
  } else {
    const sha = content.match(/sha256:([a-f0-9]{64})/)?.[1];
    outcome = sha ? `${content.length} chars, sha256:${sha}` : clip(first, 120);
  }
  const recall = storedSha ? ` · sha256:${storedSha}` : '';
  return `- ${name} ${args} → ${clip(outcome, 200)}${recall}`;
}

export type InRunCompactionResult = {
  beforeTokens: number;
  afterTokens: number;
  /** Tool calls whose rows were folded into the recap. */
  toolCallIds: string[];
  /**
   * True when even folding every removable iteration cannot reach the low
   * mark: the prior-turn prefix is the problem, and retrying each iteration
   * would only rewrite the prefix. The loop stops trying for this run.
   */
  prefixHeavy: boolean;
};

/**
 * Collapse the oldest iterations of the current run into one extractive
 * recap once the prompt passes `inRunCompactRatio` (high mark) of the input
 * budget, folding as many iterations as it takes to get under
 * `inRunCompactToRatio` (low mark) in one pass, so the next trigger needs
 * real growth. Whole iterations (assistant + its tool rows) are removed, so
 * tool_call pairing stays valid. Prompt-only; the ledger is untouched.
 * `runStart` is the index of the first message this run appended.
 *
 * `milestone`: a check just passed after edits (verified state). Fold every
 * iteration except the newest `inRunKeepToolResults` now, whatever the
 * size: the cached prefix changes once, at a known point, and what was
 * folded is on disk (files) or recallable (shas).
 */
export async function compactCurrentRun(
  messages: ChatCompletionMessageParam[],
  runStart: number,
  budget: ContextBudget,
  tools: ChatCompletionTool[],
  /** Stores large resident results folded into the recap, so recall can bring them back. */
  putBlob?: (text: string) => Promise<string>,
  options: { milestone?: boolean } = {},
): Promise<InRunCompactionResult | null> {
  const beforeTokens = estimatePromptTokens(messages, tools);
  const inputBudget = budget.windowTokens - budget.outputReserveTokens;
  const milestone = options.milestone === true;
  if (!milestone && beforeTokens < inputBudget * budget.inRunCompactRatio) return null;
  const lowMark = milestone ? 0 : inputBudget * budget.inRunCompactToRatio;

  // An existing recap sits at runStart; fold it into the new one.
  const { start, priorRecap } = recapStart(messages, runStart);

  const groupStarts: number[] = [];
  for (let i = start; i < messages.length; i++) {
    if (messages[i]?.role === 'assistant') groupStarts.push(i);
  }
  const keepGroups = Math.max(1, budget.inRunKeepToolResults);
  // Too few iterations yet to fold; try again once the run has grown.
  const removable = groupStarts.length - keepGroups;
  if (removable <= 0) return null;

  // Fold groups oldest-first until the estimate (minus folded, plus a recap
  // line per tool row) reaches the low mark, or nothing removable is left.
  let cutEnd = groupStarts[1] ?? messages.length;
  let estimate = beforeTokens;
  for (let g = 0; g < removable; g++) {
    const from = groupStarts[g]!;
    const to = groupStarts[g + 1] ?? messages.length;
    estimate -= estimatePromptTokens(messages.slice(from, to));
    estimate += 60 * messages.slice(from, to).filter((m) => m.role === 'tool').length / CHARS_PER_TOKEN;
    cutEnd = to;
    if (estimate <= lowMark) break;
  }
  // A milestone folds by design, not to reach a mark: never prefix-heavy.
  const prefixHeavy = !milestone && estimate > lowMark;

  const toolCallIds = await foldIntoRecap(messages, runStart, start, cutEnd, priorRecap, putBlob);
  return {
    beforeTokens,
    afterTokens: estimatePromptTokens(messages, tools),
    toolCallIds,
    prefixHeavy,
  };
}

/** Where the run's own steps begin (after an existing recap) and that recap's text. */
function recapStart(messages: ChatCompletionMessageParam[], runStart: number): { start: number; priorRecap: string } {
  const first = messages[runStart];
  if (first?.role === 'assistant' && textOf(first.content).startsWith(RECAP_PREFIX)) {
    return { start: runStart + 1, priorRecap: textOf(first.content).slice(RECAP_PREFIX.length).trim() };
  }
  return { start: runStart, priorRecap: '' };
}

/** Text this run can no longer remove: cards of removed results and its tool calls' arguments. */
function residueChars(messages: ChatCompletionMessageParam[], from: number, to = messages.length): number {
  let chars = 0;
  for (let i = from; i < to; i++) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === 'tool' && typeof message.content === 'string' && !isResident(message.content)) {
      chars += message.content.length;
    } else if (message.role === 'assistant' && message.tool_calls) {
      for (const call of message.tool_calls) {
        if ('function' in call) chars += call.function.name.length + call.function.arguments.length;
      }
    }
  }
  return chars;
}

/**
 * Fold old steps that hold nothing resident any more (their results are all
 * cards, stubs or small) into the recap, once this run's residue (cards and
 * old call arguments) passes `inRunResidueFoldTokens`. Unlike the size mark,
 * this cannot remove working-set content: it stops at the first step that
 * still has a resident result, a sub-agent report, or live state (plan).
 * The newest `inRunKeepToolResults` steps stay. Prompt-only.
 */
export async function foldResidue(
  messages: ChatCompletionMessageParam[],
  runStart: number,
  budget: ContextBudget,
  tools: ChatCompletionTool[],
): Promise<InRunCompactionResult | null> {
  if (residueChars(messages, runStart) / CHARS_PER_TOKEN < budget.inRunResidueFoldTokens) return null;
  const { start, priorRecap } = recapStart(messages, runStart);
  const groupStarts: number[] = [];
  for (let i = start; i < messages.length; i++) {
    if (messages[i]?.role === 'assistant') groupStarts.push(i);
  }
  const removable = groupStarts.length - Math.max(1, budget.inRunKeepToolResults);
  const calls = toolCallIndex(messages);
  let cutEnd = start;
  for (let g = 0; g < removable; g++) {
    const from = groupStarts[g]!;
    const to = groupStarts[g + 1] ?? messages.length;
    const holdsLive = messages.slice(from, to).some((message) => {
      if (message.role !== 'tool' || typeof message.content !== 'string') return false;
      const name = calls.get(message.tool_call_id)?.name;
      if (name === 'delegate' || (name && NEVER_EVICT.has(name))) return message.content.length >= MIN_EVICT_CHARS;
      return isResident(message.content) && message.content.length >= MIN_EVICT_CHARS;
    });
    if (holdsLive) break;
    cutEnd = to;
  }
  // Worth a change to the cached prompt only when it clears a real share of the mark.
  if (cutEnd === start || residueChars(messages, start, cutEnd) / CHARS_PER_TOKEN < budget.inRunResidueFoldTokens / 2) {
    return null;
  }
  const beforeTokens = estimatePromptTokens(messages, tools);
  const toolCallIds = await foldIntoRecap(messages, runStart, start, cutEnd, priorRecap);
  return { beforeTokens, afterTokens: estimatePromptTokens(messages, tools), toolCallIds, prefixHeavy: false };
}

/**
 * Replace messages [runStart, cutEnd) with one recap: the prior recap, then
 * one line per note and tool outcome of the folded steps. Large resident
 * results are stored first so their sha stays recallable.
 */
async function foldIntoRecap(
  messages: ChatCompletionMessageParam[],
  runStart: number,
  start: number,
  cutEnd: number,
  priorRecap: string,
  putBlob?: (text: string) => Promise<string>,
): Promise<string[]> {
  const calls = toolCallIndex(messages);
  const lines: string[] = priorRecap ? [priorRecap] : [];
  const toolCallIds: string[] = [];
  for (let i = start; i < cutEnd; i++) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === 'assistant') {
      const text = clip(textOf(message.content), 300);
      if (text) lines.push(`Note: ${text}`);
    } else if (message.role === 'tool' && typeof message.content === 'string') {
      const info = calls.get(message.tool_call_id);
      // Edit hunks are not worth keeping (the file is the source of truth);
      // cards already carry their own sha.
      const keepBody =
        putBlob !== undefined &&
        info?.name !== 'edit_file' &&
        message.content.length >= MIN_EVICT_CHARS &&
        isResident(message.content);
      const storedSha = keepBody ? await putBlob(message.content) : undefined;
      lines.push(outcomeLine(info, message.content, storedSha));
      toolCallIds.push(message.tool_call_id);
    }
  }

  let recap = lines.join('\n');
  if (recap.length > RECAP_MAX_CHARS) {
    recap = `…\n${recap.slice(recap.length - RECAP_MAX_CHARS)}`;
  }
  messages.splice(runStart, cutEnd - runStart, {
    role: 'assistant',
    content: `${RECAP_PREFIX}\nEarlier steps of this run, condensed. Re-read files before relying on old contents; recall a sha256 for an exact earlier result.\n${recap}`,
  });
  return toolCallIds;
}

const SEARCH_KEY = 'search|';

function canonicalArgs(args: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(args).sort().map((key) => [key, args[key]]));
}

/**
 * Answers a read_file or search (grep, glob) that returns exactly what an
 * earlier identical call returned, while that earlier result is still in
 * the prompt in full: the model gets a pointer instead of the same text
 * twice. Eviction and compaction call `forget`; a re-read of text that was
 * removed is then a restore (the caller traces it). An edit to the path
 * invalidates its reads and every search; any terminal command (formatters,
 * codegen) invalidates everything.
 */
export class ReadDedupe {
  private seen = new Map<string, { sha: string; iteration: number; toolCallId: string }>();
  /** Keys whose result left the prompt, with the sha it had: a matching re-read is a restore. */
  private removed = new Map<string, string>();

  /** `path` is the loop's canonical form, so `./a.ts` and `a.ts` share a key. */
  apply(
    path: string,
    args: Record<string, unknown>,
    result: string,
    iteration: number,
    toolCallId: string,
  ): { text: string; restored: boolean } {
    if (!path || result.startsWith('Error')) return { text: result, restored: false };
    // Key on the lines actually returned: a file that fits comes back whole
    // whatever offset/limit asked, so two differently-sliced asks can be
    // the same read. Args are the fallback for results without a header.
    const range = readRange(result);
    const key = range
      ? `${path}|${range.from}-${range.to}`
      : `${path}|${String(args.offset ?? '')}|${String(args.limit ?? '')}`;
    const sha = sha256Text(result);
    const prior = this.seen.get(key);
    if (prior && prior.sha === sha) {
      return {
        text: `${UNCHANGED_PREFIX} since iteration ${prior.iteration}) ${path}: identical to the earlier read_file result above.`,
        restored: false,
      };
    }
    const restored = this.removed.get(key) === sha;
    this.removed.delete(key);
    this.seen.set(key, { sha, iteration, toolCallId });
    return { text: result, restored };
  }

  /** Same idea for grep and glob: an identical search with nothing edited since answers with a pointer. */
  applySearch(
    toolName: string,
    args: Record<string, unknown>,
    result: string,
    iteration: number,
    toolCallId: string,
  ): string {
    if (result.startsWith('Error') || result.startsWith('Invalid')) return result;
    const key = `${SEARCH_KEY}${toolName}|${canonicalArgs(args)}`;
    const sha = sha256Text(result);
    const prior = this.seen.get(key);
    if (prior && prior.sha === sha) {
      return `${UNCHANGED_PREFIX} since iteration ${prior.iteration}) ${toolName}: identical to the earlier result above.`;
    }
    this.seen.set(key, { sha, iteration, toolCallId });
    return result;
  }

  /** The results of these tool calls left the prompt; stop pointing at them. */
  forget(toolCallIds: Iterable<string>): void {
    const gone = new Set(toolCallIds);
    if (gone.size === 0) return;
    for (const [key, entry] of this.seen) {
      if (!gone.has(entry.toolCallId)) continue;
      this.seen.delete(key);
      if (!key.startsWith(SEARCH_KEY)) this.removed.set(key, entry.sha);
    }
  }

  /** An edit changed this file: its reads and every search may return something else now. */
  invalidatePath(path: string): void {
    const prefix = `${path.trim()}|`;
    for (const key of [...this.seen.keys()]) {
      if (key.startsWith(prefix) || key.startsWith(SEARCH_KEY)) this.seen.delete(key);
    }
    for (const key of [...this.removed.keys()]) {
      if (key.startsWith(prefix)) this.removed.delete(key);
    }
  }

  clear(): void {
    this.seen.clear();
    this.removed.clear();
  }
}
