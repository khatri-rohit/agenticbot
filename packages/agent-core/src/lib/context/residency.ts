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
 * starts; inside one long run nothing else shrinks the prompt, so every
 * iteration re-sends every tool result. These passes keep a long run's
 * prompt bounded without an LLM call: evict old tool results to cards,
 * retire applied skill bodies to their core rules, collapse old iterations
 * of the current turn into a recap, and answer unchanged re-reads with a
 * pointer while the earlier result is still resident.
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

function evictionCard(
  info: ToolCallInfo | undefined,
  content: string,
  sha: string,
  why = '',
): string {
  const name = info?.name ?? 'tool';
  const args = info ? ` ${argsPreview(info.args)}` : '';
  return `${CARD_PREFIX} ${name}${args}${why ? ` · ${why}` : ''} · ${content.length} chars · sha256:${sha} — call recall with this sha256 to read it again.`;
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
 * Card older tool results that a later result in the prompt makes redundant,
 * so the model does not carry two versions of one thing (and act on the
 * stale one):
 * - read_file whose line range a later resident read of the same path covers;
 * - run_terminal whose exact command ran again later.
 * Edits do not supersede reads: several edits from one read are normal, and
 * carding that read would force a re-read. Cards keep the sha (recall).
 * Applied only when it frees at least `inRunClearAtLeastTokens`, so the
 * cached prefix changes rarely and in large steps, like eviction.
 * `pathOf` returns the loop's canonical path for read_file args.
 */
export async function supersedeToolResults(
  messages: ChatCompletionMessageParam[],
  budget: ContextBudget,
  tools: ChatCompletionTool[],
  putBlob: (text: string) => Promise<string>,
  pathOf: (args: Record<string, unknown>) => string | null,
): Promise<EvictionResult | null> {
  const calls = toolCallIndex(messages);
  const laterReads = new Map<string, Array<{ from: number; to: number }>>();
  const laterCommands = new Set<string>();
  const candidates: Array<{ index: number; why: string }> = [];
  let freedChars = 0;

  // Newest first: each result is compared with what came after it.
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'tool' || typeof message.content !== 'string') continue;
    const content = message.content;
    if (!isResident(content)) continue;
    const info = calls.get(message.tool_call_id);
    if (!info || (info.name !== 'read_file' && info.name !== 'run_terminal')) continue;
    const args = parseArgs(info.args);

    if (info.name === 'read_file') {
      const path = pathOf(args);
      const range = readRange(content);
      if (!path || !range) continue;
      const later = laterReads.get(path) ?? [];
      const covered = later.some((r) => r.from <= range.from && r.to >= range.to);
      if (covered && content.length >= MIN_EVICT_CHARS) {
        candidates.push({ index: i, why: 'superseded by a later read of the same lines' });
        freedChars += content.length - 250;
      } else if (!covered) {
        later.push(range);
        laterReads.set(path, later);
      }
    } else if (info.name === 'run_terminal') {
      const command = typeof args.command === 'string' ? args.command.trim() : '';
      // Only a command that actually ran (`cwd: …` then `exit|signal`) counts:
      // a blocked, skipped, or repeat-refused call must not card a real run.
      if (!command || !terminalRan(content)) continue;
      if (laterCommands.has(command)) {
        if (content.length >= MIN_EVICT_CHARS) {
          candidates.push({ index: i, why: 'superseded by a later run of the same command' });
          freedChars += content.length - 250;
        }
      } else {
        laterCommands.add(command);
      }
    }
  }
  if (candidates.length === 0) return null;
  if (freedChars / CHARS_PER_TOKEN < budget.inRunClearAtLeastTokens) return null;

  const beforeTokens = estimatePromptTokens(messages, tools);
  const toolCallIds: string[] = [];
  for (const { index, why } of candidates) {
    const message = messages[index];
    if (message?.role !== 'tool' || typeof message.content !== 'string') continue;
    const info = calls.get(message.tool_call_id);
    const sha = await putBlob(message.content);
    messages[index] = {
      role: 'tool',
      tool_call_id: message.tool_call_id,
      content: evictionCard(info, message.content, sha, why),
    };
    toolCallIds.push(message.tool_call_id);
  }
  return {
    evicted: toolCallIds.length,
    beforeTokens,
    afterTokens: estimatePromptTokens(messages, tools),
    toolCallIds,
  };
}

export type EvictionResult = {
  evicted: number;
  beforeTokens: number;
  afterTokens: number;
  /** Tool calls whose results are no longer resident in full. */
  toolCallIds: string[];
};

/**
 * Replace old tool results with cards once the live prompt passes
 * `budget.inRunEvictTokens`. Keeps the newest `inRunKeepToolResults` and
 * skips the pass when it would free less than `inRunClearAtLeastTokens`,
 * so the cached prefix changes rarely and in large steps.
 */
export async function evictToolResults(
  messages: ChatCompletionMessageParam[],
  budget: ContextBudget,
  tools: ChatCompletionTool[],
  putBlob: (text: string) => Promise<string>,
): Promise<EvictionResult | null> {
  const beforeTokens = estimatePromptTokens(messages, tools);
  if (beforeTokens < budget.inRunEvictTokens) return null;

  const calls = toolCallIndex(messages);
  const toolIndexes: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === 'tool') toolIndexes.push(i);
  }
  const keep = new Set(toolIndexes.slice(-budget.inRunKeepToolResults));

  const candidates: number[] = [];
  let freedChars = 0;
  for (const index of toolIndexes) {
    if (keep.has(index)) continue;
    const message = messages[index];
    if (message?.role !== 'tool' || typeof message.content !== 'string') continue;
    const content = message.content;
    if (content.length < MIN_EVICT_CHARS || !isResident(content)) continue;
    const name = calls.get(message.tool_call_id)?.name;
    if (name && NEVER_EVICT.has(name)) continue;
    candidates.push(index);
    // A card is ~250 chars; close enough to decide whether the pass pays.
    freedChars += content.length - 250;
  }
  if (freedChars / CHARS_PER_TOKEN < budget.inRunClearAtLeastTokens) return null;

  const toolCallIds: string[] = [];
  for (const index of candidates) {
    const message = messages[index];
    if (message?.role !== 'tool' || typeof message.content !== 'string') continue;
    const info = calls.get(message.tool_call_id);
    const content = message.content;
    const card =
      info?.name === 'edit_file'
        ? editCard(content)
        : evictionCard(info, content, await putBlob(content));
    messages[index] = { role: 'tool', tool_call_id: message.tool_call_id, content: card };
    toolCallIds.push(message.tool_call_id);
  }

  return {
    evicted: candidates.length,
    beforeTokens,
    afterTokens: estimatePromptTokens(messages, tools),
    toolCallIds,
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
 */
export async function compactCurrentRun(
  messages: ChatCompletionMessageParam[],
  runStart: number,
  budget: ContextBudget,
  tools: ChatCompletionTool[],
  /** Stores large resident results folded into the recap, so recall can bring them back. */
  putBlob?: (text: string) => Promise<string>,
): Promise<InRunCompactionResult | null> {
  const beforeTokens = estimatePromptTokens(messages, tools);
  const inputBudget = budget.windowTokens - budget.outputReserveTokens;
  if (beforeTokens < inputBudget * budget.inRunCompactRatio) return null;
  const lowMark = inputBudget * budget.inRunCompactToRatio;

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
  const prefixHeavy = estimate > lowMark;

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
