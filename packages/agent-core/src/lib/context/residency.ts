import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';

import { CHARS_PER_TOKEN, type ContextBudget } from '@agent/agent-models';

import { estimatePromptTokens } from '../model/estimate-prompt-tokens';
import { skillCard } from '../tools/skills';
import { sha256Text } from '../tools/web-source';

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
const ARGS_PREVIEW_MAX = 160;

type ToolCallInfo = { name: string; args: string };

function toolCallIndex(
  messages: ChatCompletionMessageParam[],
): Map<string, ToolCallInfo> {
  const byId = new Map<string, ToolCallInfo>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.tool_calls) continue;
    for (const call of message.tool_calls) {
      if (call.type !== 'function') continue;
      byId.set(call.id, {
        name: call.function.name,
        args: call.function.arguments,
      });
    }
  }
  return byId;
}

function argsPreview(raw: string): string {
  const compact = raw.replace(/\s+/g, ' ').trim();
  return compact.length > ARGS_PREVIEW_MAX
    ? `${compact.slice(0, ARGS_PREVIEW_MAX)}…`
    : compact;
}

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

function evictionCard(info: ToolCallInfo | undefined, content: string, sha: string): string {
  const name = info?.name ?? 'tool';
  const args = info ? ` ${argsPreview(info.args)}` : '';
  return `${CARD_PREFIX} ${name}${args} · ${content.length} chars · sha256:${sha} — call recall with this sha256 to read it again.`;
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

/** One line per tool outcome: what was done and what came back. */
function outcomeLine(info: ToolCallInfo | undefined, content: string): string {
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
  return `- ${name} ${args} → ${clip(outcome, 200)}`;
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
export function compactCurrentRun(
  messages: ChatCompletionMessageParam[],
  runStart: number,
  budget: ContextBudget,
  tools: ChatCompletionTool[],
): InRunCompactionResult | null {
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
      lines.push(outcomeLine(calls.get(message.tool_call_id), message.content));
      toolCallIds.push(message.tool_call_id);
    }
  }

  let recap = lines.join('\n');
  if (recap.length > RECAP_MAX_CHARS) {
    recap = `…\n${recap.slice(recap.length - RECAP_MAX_CHARS)}`;
  }
  messages.splice(runStart, cutEnd - runStart, {
    role: 'assistant',
    content: `${RECAP_PREFIX}\nEarlier steps of this run, condensed. Re-read files before relying on old contents.\n${recap}`,
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
    const key = `${path}|${String(args.offset ?? '')}|${String(args.limit ?? '')}`;
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
