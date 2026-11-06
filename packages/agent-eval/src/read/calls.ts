import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { CHARS_PER_TOKEN, type LedgerEnvelope, type TraceCallInput } from '@agent/agent-models';

import { readLedger } from './ledger.js';
import type { RunSummary } from './runs.js';
import { linesOf, readRunTrace, type TraceLine } from './trace.js';

const SHA = /^[0-9a-f]{64}$/;

/** One model call of a run, from its trace lines alone (cheap: no blobs). */
export type CallSummary = {
  /** 1-based position among the run's model calls. */
  index: number;
  iteration: number;
  /** A tools-off final call (limit handoff, deferred choice). */
  final: boolean;
  seq?: number;
  promptTokens?: number;
  completionTokens?: number;
  durationMs?: number;
  effort?: string;
  /** The run recorded this call's input (llm_request.input). */
  recorded: boolean;
};

export type MessageKind = 'system' | 'user' | 'assistant' | 'tool' | 'injected';

export type CallMessage = {
  index: number;
  role: string;
  kind: MessageKind;
  /** null when the blob is missing (write failed or the thread was cleaned). */
  text: string | null;
  chars: number;
  tokens: number;
  toolCallId?: string;
  toolCalls?: { id: string; name: string; args: string }[];
  /** Tool message sent in a shorter form than its ledger row (stubbed, evicted, folded). */
  stub?: boolean;
  /** Not in the previous call. */
  added?: boolean;
};

export type CallDetail = {
  call: CallSummary;
  input: CallMessage[];
  tools: { names: string[]; tokens: number } | null;
  output: { text: string | null; toolCalls: { id: string; name: string; args: string }[] } | null;
  /** Against the previous call: messages it no longer sent (compaction, eviction replace). */
  removed: number;
  tokensByKind: Record<MessageKind | 'tools', number>;
  /** `rewound`: the run's rows were cut from the ledger (retry/edit), so nothing can be labelled injected. */
  ledger: 'matched' | 'rewound';
};

/** The run's model calls in order: each `llm_request` with the `llm_response` that follows it. */
export function listCalls(lines: TraceLine[]): CallSummary[] {
  const calls: CallSummary[] = [];
  let pending: CallSummary | null = null;
  for (const line of lines) {
    if (line.type === 'llm_request') {
      pending = {
        index: calls.length + 1,
        iteration: line.iteration,
        final: line.final === true,
        ...(line.seq !== undefined ? { seq: line.seq } : {}),
        ...(line.reasoningEffort ? { effort: line.reasoningEffort } : {}),
        recorded: Boolean(line.input),
      };
      calls.push(pending);
    } else if (line.type === 'llm_response' && pending) {
      if (line.usage) {
        pending.promptTokens = line.usage.promptTokens;
        pending.completionTokens = line.usage.completionTokens;
      }
      if (line.durationMs !== undefined) pending.durationMs = line.durationMs;
      pending = null;
    }
  }
  return calls;
}

function tokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: { type?: string; text?: string }) => (part.type === 'text' ? (part.text ?? '') : '[image]'))
      .join('');
  }
  return '';
}

/** A message's own words, for matching against the ledger (images aside, trimmed as the host sends them). */
function wordsOf(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .map((part: { type?: string; text?: string }) => (part.type === 'text' && !part.text?.startsWith('[image ') ? (part.text ?? '') : ''))
      .join('')
      .trim();
  }
  return typeof content === 'string' ? content.trim() : '';
}

type BlobReader = (sha: string) => Promise<string | null>;

function blobReader(home: string, threadId: string): BlobReader {
  return async (sha) => {
    if (!SHA.test(sha)) return null;
    try {
      return await readFile(path.join(home, 'sessions', threadId, 'blobs', sha), 'utf8');
    } catch {
      return null;
    }
  };
}

/** A tool call's full result as the ledger stored it (the blob when the row was offloaded); null when absent. */
export async function readToolResult(home: string, threadId: string, toolCallId: string): Promise<string | null> {
  const { envelopes } = await readLedger(home, threadId);
  const row = envelopes.find((envelope) => envelope.record.role === 'tool' && envelope.record.tool_call_id === toolCallId);
  if (!row || row.record.role !== 'tool') return null;
  return (row.contentBlob ? await blobReader(home, threadId)(row.contentBlob) : null) ?? row.record.content;
}

/** Full text of every ledger tool row by call id, and every user text, for matching. */
async function ledgerIndex(envelopes: LedgerEnvelope[], blob: BlobReader) {
  const toolText = new Map<string, string>();
  const userTexts = new Set<string>();
  for (const envelope of envelopes) {
    const record = envelope.record;
    if (record.role === 'tool') {
      const full = envelope.contentBlob ? await blob(envelope.contentBlob) : null;
      toolText.set(record.tool_call_id, full ?? record.content);
    } else if (record.role === 'user') {
      userTexts.add(wordsOf(record.content));
    }
  }
  return { toolText, userTexts };
}

type SentMessage = {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
};

/**
 * Exactly what call `index` of a run sent and got back, rebuilt from its
 * blobs, with each message labelled by kind and compared with the call
 * before it. Null when the run has no such call. The only module that
 * knows where recorded calls live.
 */
export async function readCall(home: string, run: RunSummary, index: number): Promise<CallDetail | null> {
  const { lines } = await readRunTrace(run.tracePath);
  const calls = listCalls(lines);
  const call = calls[index - 1];
  if (!call) return null;
  const requests = linesOf(lines, 'llm_request');
  const responses = lines.filter((line) => line.type === 'llm_response');
  const input: TraceCallInput | undefined = requests[index - 1]?.input;
  const previous: TraceCallInput | undefined = requests[index - 2]?.input;
  const responseLine = responses[index - 1];
  const outputRef = responseLine?.type === 'llm_response' ? responseLine.output : undefined;

  const blob = blobReader(home, run.threadId);
  const { envelopes } = await readLedger(home, run.threadId);
  const runRows = envelopes.filter((envelope) => envelope.runId === run.runId);
  const ledgerState = runRows.length > 0 ? 'matched' : 'rewound';
  const { toolText, userTexts } = await ledgerIndex(envelopes, blob);
  const previousShas = new Set(previous?.messages.map((ref) => ref.sha) ?? []);

  const messages: CallMessage[] = [];
  for (const [i, ref] of (input?.messages ?? []).entries()) {
    const raw = await blob(ref.sha);
    const sent = raw ? (JSON.parse(raw) as SentMessage) : null;
    const text = sent ? textOf(sent.content) : null;
    let kind: MessageKind =
      ref.role === 'system' || ref.role === 'tool' || ref.role === 'assistant' ? ref.role : 'user';
    if (kind === 'user' && sent && ledgerState === 'matched' && !userTexts.has(wordsOf(sent.content))) kind = 'injected';
    const full = ref.toolCallId ? toolText.get(ref.toolCallId) : undefined;
    messages.push({
      index: i,
      role: ref.role,
      kind,
      text,
      chars: ref.chars,
      tokens: tokens(ref.chars),
      ...(ref.toolCallId ? { toolCallId: ref.toolCallId } : {}),
      ...(sent?.tool_calls?.length
        ? { toolCalls: sent.tool_calls.map((tc) => ({ id: tc.id, name: tc.function.name, args: tc.function.arguments })) }
        : {}),
      ...(kind === 'tool' && text !== null && full !== undefined && full !== text ? { stub: true } : {}),
      ...(previous && !previousShas.has(ref.sha) ? { added: true } : {}),
    });
  }

  const toolsText = input?.tools ? await blob(input.tools.sha) : null;
  const tokensByKind: CallDetail['tokensByKind'] = { system: 0, user: 0, assistant: 0, tool: 0, injected: 0, tools: 0 };
  for (const message of messages) tokensByKind[message.kind] += message.tokens;
  if (toolsText) tokensByKind.tools = tokens(toolsText.length);

  let output: CallDetail['output'] = null;
  if (outputRef) {
    const raw = await blob(outputRef.sha);
    const sent = raw ? (JSON.parse(raw) as SentMessage) : null;
    output = {
      text: sent ? textOf(sent.content) : null,
      toolCalls: (sent?.tool_calls ?? []).map((tc) => ({ id: tc.id, name: tc.function.name, args: tc.function.arguments })),
    };
  }
  const currentShas = new Set(input?.messages.map((ref) => ref.sha) ?? []);
  return {
    call,
    input: messages,
    tools: input?.tools ? { names: input.tools.names, tokens: tokensByKind.tools } : null,
    output,
    removed: previous ? previous.messages.filter((ref) => !currentShas.has(ref.sha)).length : 0,
    tokensByKind,
    ledger: ledgerState,
  };
}
