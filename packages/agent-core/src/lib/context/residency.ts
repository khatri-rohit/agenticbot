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
const CARD_PREFIX = '(evicted)';
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

export type EvictionReason = 'superseded' | 'cold' | 'budget';

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
  /** Must stay: being changed, or this iteration's result. */
  pinned: boolean;
};

function workingSetCard(candidate: Candidate, content: string, sha: string, reason: EvictionReason): string {
  const name = candidate.info?.name ?? 'tool';
  const args = candidate.info ? ` ${argsPreview(candidate.info.args)}` : '';
  const why =
    reason === 'superseded'
      ? name === 'read_file'
        ? 'superseded by a later read of the same lines'
        : 'superseded by a later run of the same command'
      : `not used since iteration ${candidate.touch}`;
  const again =
    name === 'read_file'
      ? 'read_file again for the current contents, or recall this sha256 for this exact text.'
      : 'call recall with this sha256 to read it again.';
  return `${CARD_PREFIX} ${name}${args} · ${why} · ${content.length} chars · sha256:${sha} — ${again}`;
}

/**
 * Keep this run's tool results to the working set (task state decides):
 * - superseded: a later resident read covers the same lines of the same
 *   file, or the same command ran again (only commands that executed count);
 * - cold: a file not read or edited for `inRunColdAfterIterations`, or any
 *   other result that old, except the newest `inRunKeepToolResults` non-file
 *   results;
 * - budget: past `inRunResidentToolTokens` of resident results, least
 *   recently touched first.
 * A file edited since the last check, and this iteration's results, always
 * stay. Edits never supersede reads (several edits from one read are
 * normal). Superseded and cold cards apply in steps of at least
 * `inRunClearAtLeastTokens` (each pass changes the cached prefix); the
 * budget applies at once. Every card keeps a sha for recall. Results from
 * earlier turns are only superseded (assembleContext already stubs them).
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
    candidates.push({
      index: i,
      toolCallId: message.tool_call_id,
      info,
      chars: content.length,
      touch,
      path,
      superseded,
      cold: cold && !pinned,
      pinned,
    });
  }

  // Superseded results are stale even when pinned: the newer copy is resident.
  const chosen = new Map<number, EvictionReason>();
  let stepChars = 0;
  for (const candidate of candidates) {
    if (candidate.superseded) {
      chosen.set(candidate.index, 'superseded');
      stepChars += candidate.chars - 250;
    } else if (candidate.cold) {
      chosen.set(candidate.index, 'cold');
      stepChars += candidate.chars - 250;
    }
  }
  if (stepChars / CHARS_PER_TOKEN < budget.inRunClearAtLeastTokens) chosen.clear();

  // The resident cap applies at once: oldest touch first, never pinned.
  const budgetChars = budget.inRunResidentToolTokens * CHARS_PER_TOKEN;
  let residentChars = candidates
    .filter((candidate) => candidate.index >= runStart && !chosen.has(candidate.index))
    .reduce((sum, candidate) => sum + candidate.chars, 0);
  if (residentChars > budgetChars) {
    const byAge = candidates
      .filter((candidate) => candidate.index >= runStart && !candidate.pinned && !chosen.has(candidate.index))
      .sort((a, b) => a.touch - b.touch || a.index - b.index);
    for (const candidate of byAge) {
      if (residentChars <= budgetChars) break;
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
  let start = runStart;
  let priorRecap = '';
  const first = messages[start];
  if (first?.role === 'assistant' && textOf(first.content).startsWith(RECAP_PREFIX)) {
    priorRecap = textOf(first.content).slice(RECAP_PREFIX.length).trim();
    start += 1;
  }

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

  return {
    beforeTokens,
    afterTokens: estimatePromptTokens(messages, tools),
    toolCallIds,
    prefixHeavy,
  };
}

/**
 * Answers a read_file that returns exactly what an earlier read of the same
 * path and range returned — only while that earlier result is still in the
 * prompt in full. Eviction and compaction call `forget`; an edit to the path
 * or any terminal command (formatters, codegen) invalidates it.
 */
export class ReadDedupe {
  private seen = new Map<string, { sha: string; iteration: number; toolCallId: string }>();

  /** `path` is the loop's canonical form, so `./a.ts` and `a.ts` share a key. */
  apply(
    path: string,
    args: Record<string, unknown>,
    result: string,
    iteration: number,
    toolCallId: string,
  ): string {
    if (!path || result.startsWith('Error')) return result;
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
      return `${UNCHANGED_PREFIX} since iteration ${prior.iteration}) ${path}: identical to the earlier read_file result above.`;
    }
    this.seen.set(key, { sha, iteration, toolCallId });
    return result;
  }

  /** The results of these tool calls left the prompt; stop pointing at them. */
  forget(toolCallIds: Iterable<string>): void {
    const gone = new Set(toolCallIds);
    if (gone.size === 0) return;
    for (const [key, entry] of this.seen) {
      if (gone.has(entry.toolCallId)) this.seen.delete(key);
    }
  }

  invalidatePath(path: string): void {
    const prefix = `${path.trim()}|`;
    for (const key of this.seen.keys()) {
      if (key.startsWith(prefix)) this.seen.delete(key);
    }
  }

  clear(): void {
    this.seen.clear();
  }
}
