import type { LedgerEnvelope } from '@agent/agent-models';

/**
 * Deterministic per-send context, built from the ledger with no model call.
 *
 * The situation card puts the lead of the previous answer next to the new
 * message, so a correction or pushback is hard to miss. The evidence log
 * lists what the harness recorded (edits, commands and their exit codes,
 * failed calls) from the whole ledger, so it survives compaction and
 * follows a rewind (the ledger is truncated, the log is rebuilt).
 */

const LEAD_MAX = 280;
const EVIDENCE_MAX_LINES = 12;
const FAILED_PREFIX = 'Tool execution failed:';

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** First sentence of the first prose line; null when the answer opens with code or is empty. */
function leadOf(content: string): string | null {
  const line = content
    .split('\n')
    .map((row) => row.replace(/^#+\s*/, '').trim())
    .find((row) => row.length > 0);
  if (!line || line.startsWith('```')) return null;
  const sentence = /^(.+?[.!?])(\s|$)/.exec(line)?.[1] ?? line;
  return clip(sentence, LEAD_MAX);
}

export function buildSituationCard(input: {
  envelopes: LedgerEnvelope[];
  /** Seq of the current user message; the previous answer is before it. */
  lastUserSeq: number | undefined;
}): string | null {
  if (input.lastUserSeq === undefined) return null;
  let lead: string | null = null;
  for (let i = input.envelopes.length - 1; i >= 0; i--) {
    const envelope = input.envelopes[i];
    if (!envelope || envelope.seq >= input.lastUserSeq) continue;
    const { record } = envelope;
    if (record.role !== 'assistant' || record.tool_calls?.length) continue;
    lead = leadOf(record.content ?? '');
    if (lead) break;
  }
  if (!lead) return null;
  return [
    '# Situation',
    `Your previous answer began: "${lead}"`,
    'Read the new message against it. If it corrects, rejects, or narrows that answer, follow the new message and say what changed.',
  ].join('\n');
}

type CallInfo = { name: string; args: Record<string, unknown> };

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

function evidenceLine(info: CallInfo, content: string): string | null {
  if (content.startsWith(FAILED_PREFIX)) {
    return `${info.name} failed: ${clip(content.slice(FAILED_PREFIX.length), 160)}`;
  }
  if (info.name === 'edit_file') {
    const path = typeof info.args.path === 'string' ? info.args.path : '?';
    return `edit_file ${path} → ${clip(content.split('\n')[0] ?? '', 140)}`;
  }
  if (info.name === 'run_terminal') {
    const command = typeof info.args.command === 'string' ? info.args.command : '?';
    // `cwd: …`, then `exit <n>` / `signal <name>`; blocked runs return one line.
    const status = content.split('\n')[1]?.trim() ?? '';
    const outcome = /^(exit|signal) /.test(status) ? status : clip(content, 120);
    return `run_terminal \`${clip(command, 100)}\` → ${outcome}`;
  }
  return null;
}

export function buildEvidenceLog(envelopes: LedgerEnvelope[]): string | null {
  const calls = new Map<string, CallInfo>();
  const lines: string[] = [];
  let turn = 0;
  for (const envelope of envelopes) {
    const { record } = envelope;
    if (record.role === 'user') {
      turn += 1;
      continue;
    }
    if (record.role === 'assistant') {
      for (const call of record.tool_calls ?? []) {
        if (call.type !== 'function') continue;
        calls.set(call.id, {
          name: call.function.name,
          args: parseArgs(call.function.arguments),
        });
      }
      continue;
    }
    if (record.role !== 'tool') continue;
    const info = calls.get(record.tool_call_id);
    if (!info) continue;
    const line = evidenceLine(info, record.content);
    if (line) lines.push(`- turn ${turn}: ${line}`);
  }
  if (lines.length === 0) return null;
  return [
    '# Evidence log (recorded by the harness, newest last)',
    ...lines.slice(-EVIDENCE_MAX_LINES),
  ].join('\n');
}
