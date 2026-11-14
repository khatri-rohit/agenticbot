import { readFile } from 'node:fs/promises';

import { FINDING_CLAIM_MAX_CHARS, FINDING_EVIDENCE_MAX_CHARS } from '@agent/agent-models';

import {
  evidenceParts,
  parseCitation,
  type Citation,
  type FindingVerification,
} from '../state/task-state';
import type { Tool } from './types';
import { resolveWorkspacePath } from './workspace/path';

/** Lines around a cited range where quoted text still counts as found there. */
const QUOTE_SLACK_LINES = 3;
/** Shorter quoted text is too common to check (e.g. "id"). */
const QUOTE_MIN_CHARS = 4;
/** Occurrences of one quote considered when correcting a citation. */
const QUOTE_MAX_OCCURRENCES = 50;
/**
 * The result's first line stays under the trace preview (300 chars), so the
 * task state can read the evidence back from it; longer detail moves to the
 * next line.
 */
const FIRST_LINE_MAX_CHARS = 280;
const QUOTE_DETAIL_MAX_CHARS = 40;

/**
 * Quoted strings in a claim ("…", “…”, `…`, or '…' not inside a word, so
 * "it's" is not a quote), at least QUOTE_MIN_CHARS long, each once.
 */
export function quotedText(claim: string): string[] {
  const re = /"([^"\n]+)"|“([^”\n]+)”|`([^`\n]+)`|(?<![\p{L}\p{N}])'([^'\n]+)'(?![\p{L}\p{N}])/gu;
  const found = new Set<string>();
  for (const match of claim.matchAll(re)) {
    const text = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? '').trim();
    if (text.length >= QUOTE_MIN_CHARS) found.add(text);
  }
  return [...found];
}

type Part = { text: string; cite: Citation | null };

/** Evidence parts; a bare `40` or `40-52` after a citation means more lines of that file. */
function parseParts(evidence: string): Part[] {
  let lastPath: string | null = null;
  return evidenceParts(evidence).map((text) => {
    let cite = parseCitation(text);
    if (!cite && lastPath) {
      const lines = /^L?(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(text);
      if (lines) {
        const a = Number(lines[1]);
        const b = lines[2] ? Number(lines[2]) : a;
        cite = { path: lastPath, from: Math.min(a, b), to: Math.max(a, b) };
      }
    }
    if (cite) lastPath = cite.path;
    return { text, cite };
  });
}

type FileText = { ok: true; text: string; lines: string[] } | { ok: false; error: string };

async function loadFile(root: string, rel: string): Promise<FileText> {
  const resolved = await resolveWorkspacePath(root, rel);
  if (!resolved.ok) return { ok: false, error: `${rel}: ${resolved.error}` };
  try {
    const text = (await readFile(resolved.abs, 'utf8')).replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    if (text.endsWith('\n')) lines.pop();
    return { ok: true, text, lines };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, error: `${rel} not found` };
    if (code === 'EISDIR') return { ok: false, error: `${rel} is a folder, not a file` };
    return { ok: false, error: `${rel} could not be read` };
  }
}

const collapse = (text: string) => text.replace(/\s+/g, ' ');

/** The quote is within the cited lines ±QUOTE_SLACK_LINES. */
function inCitedLines(file: { lines: string[] }, cite: Citation, quote: string): boolean {
  if (cite.from === undefined || cite.to === undefined) return false;
  const lo = Math.max(1, cite.from - QUOTE_SLACK_LINES);
  const hi = Math.min(file.lines.length, cite.to + QUOTE_SLACK_LINES);
  if (lo > hi) return false;
  const window = file.lines.slice(lo - 1, hi).join('\n');
  return window.includes(quote) || collapse(window).includes(collapse(quote));
}

/** Lines (1-based, first–last) where the quote occurs in the file. */
function occurrences(file: { text: string }, quote: string): Array<{ from: number; to: number }> {
  const found: Array<{ from: number; to: number }> = [];
  const span = quote.split('\n').length - 1;
  let line = 1;
  let scanned = 0;
  for (let at = file.text.indexOf(quote); at >= 0 && found.length < QUOTE_MAX_OCCURRENCES; at = file.text.indexOf(quote, at + 1)) {
    for (let i = scanned; i < at; i++) if (file.text.charCodeAt(i) === 10) line += 1;
    scanned = at;
    found.push({ from: line, to: line + span });
  }
  return found;
}

const rangeText = (range: { from: number; to: number }) =>
  range.from === range.to ? String(range.from) : `${range.from}-${range.to}`;

const clipQuote = (quote: string) =>
  quote.length > QUOTE_DETAIL_MAX_CHARS ? `${quote.slice(0, QUOTE_DETAIL_MAX_CHARS)}…` : quote;

export type FindingCheck = {
  verification: FindingVerification;
  /** The evidence to record: as given, or with corrected line numbers. */
  evidence: string;
  /** Why it is corrected or unverified (for the model). */
  detail?: string;
};

/**
 * Check a finding's evidence against the workspace. Never refuses: the
 * finding is recorded whatever this finds, with what was checked.
 * - Quoted text in the claim must appear in a cited file within the cited
 *   lines ±QUOTE_SLACK_LINES (verified). Found elsewhere in that file: the
 *   citation is corrected to the occurrence nearest the cited line. Not in
 *   the cited file(s): unverified (JSX can split text, entities differ).
 * - Without quotes: each cited file exists and the cited lines are in it.
 * - URLs, quote-only evidence, or no workspace: skipped.
 * Each cited file is read once.
 */
export async function checkFinding(
  claim: string,
  evidence: string,
  workspaceRoot: string | undefined,
): Promise<FindingCheck> {
  if (!workspaceRoot?.trim()) return { verification: 'skipped', evidence };
  const parts = parseParts(evidence);
  const cited = parts.filter((part): part is Part & { cite: Citation } => part.cite !== null);
  if (cited.length === 0) return { verification: 'skipped', evidence };

  const files = new Map<string, FileText>();
  for (const { cite } of cited) {
    if (!files.has(cite.path)) files.set(cite.path, await loadFile(workspaceRoot, cite.path));
  }
  const problems = new Set<string>();
  for (const file of files.values()) if (!file.ok) problems.add(file.error);
  const readable = cited.filter((part) => files.get(part.cite.path)?.ok);

  const quotes = quotedText(claim);
  if (quotes.length === 0) {
    for (const { cite } of readable) {
      const file = files.get(cite.path) as Extract<FileText, { ok: true }>;
      if (cite.to !== undefined && cite.to > file.lines.length) {
        problems.add(`line ${cite.to} is past the end of ${cite.path} (${file.lines.length} lines)`);
      }
    }
    return problems.size > 0
      ? { verification: 'unverified', evidence, detail: [...problems].join('; ') }
      : { verification: 'verified', evidence };
  }

  const confirmed = new Set<Part>();
  const fixes = new Map<Part, string[]>();
  const corrections: string[] = [];
  for (const quote of quotes) {
    const here = readable.find((part) =>
      inCitedLines(files.get(part.cite.path) as Extract<FileText, { ok: true }>, part.cite, quote),
    );
    if (here) {
      confirmed.add(here);
      continue;
    }
    let best: { part: Part & { cite: Citation }; range: { from: number; to: number }; distance: number } | null = null;
    for (const part of readable) {
      const file = files.get(part.cite.path) as Extract<FileText, { ok: true }>;
      for (const range of occurrences(file, quote)) {
        const distance = part.cite.from === undefined ? 0 : Math.abs(range.from - part.cite.from);
        if (!best || distance < best.distance) best = { part, range, distance };
      }
    }
    if (!best) {
      if (readable.length > 0) {
        const paths = [...new Set(readable.map((part) => part.cite.path))].join(', ');
        problems.add(`"${clipQuote(quote)}" not found in ${paths}`);
      }
      continue;
    }
    const fixed = `${best.part.cite.path}:${rangeText(best.range)}`;
    const list = fixes.get(best.part) ?? [];
    if (!list.includes(fixed)) list.push(fixed);
    fixes.set(best.part, list);
    const was =
      best.part.cite.from === undefined
        ? ''
        : `, not ${rangeText({ from: best.part.cite.from, to: best.part.cite.to ?? best.part.cite.from })}`;
    corrections.push(`"${clipQuote(quote)}" is at ${fixed}${was}`);
  }

  const corrected =
    fixes.size === 0
      ? evidence
      : [
          ...new Set(
            parts.flatMap((part) => {
              const fixed = fixes.get(part);
              if (!fixed) return [part.text];
              return confirmed.has(part) ? [part.text, ...fixed] : fixed;
            }),
          ),
        ].join('; ');
  if (problems.size > 0) {
    return { verification: 'unverified', evidence: corrected, detail: [...problems, ...corrections].join('; ') };
  }
  if (fixes.size > 0) return { verification: 'corrected', evidence: corrected, detail: corrections.join('; ') };
  return { verification: 'verified', evidence };
}

/**
 * The result: first line `Recorded (<what was checked>) — evidence: <evidence>`
 * (task-state readRecordedResult reads it back), then any advice.
 */
export function formatRecorded(check: FindingCheck, shortened: boolean): string {
  const label =
    check.verification === 'verified'
      ? 'verified'
      : check.verification === 'corrected'
        ? 'evidence corrected'
        : check.verification === 'unverified'
          ? 'unverified'
          : 'verification skipped';
  const tail = ` — evidence: ${check.evidence}`;
  const full = check.detail ? `Recorded (${label}: ${check.detail})${tail}` : `Recorded (${label})${tail}`;
  const lines = [full];
  if (full.length > FIRST_LINE_MAX_CHARS) {
    lines[0] = `Recorded (${label})${tail}`;
    if (check.detail) lines.push(`Detail: ${check.detail}`);
  }
  if (check.verification === 'corrected') {
    lines.push('The record cites the corrected lines; cite those in the answer.');
  } else if (check.verification === 'unverified') {
    lines.push(
      'Kept as unverified. If the evidence is wrong, grep for the text (grep prints exact path:line) and record the same claim with that evidence.',
    );
  }
  if (shortened) lines.push('(claim or evidence shortened to the size limits)');
  return lines.join('\n');
}

/**
 * Records one fact about the workspace into this run's task record (task
 * state reduces it from the result; the harness card shows the record every
 * step). A recorded fact is research evidence: it stands for the reads it
 * came from, so those reads can leave the prompt without being read again,
 * and the answer is written from the record. The evidence is checked against
 * the workspace and corrected when the quoted text is elsewhere in the cited
 * file; a finding is never refused for its evidence.
 */
export const record_finding: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'record_finding',
      description:
        'Record one confirmed fact for this task: a short claim and its evidence. Recorded findings are kept for the rest of the run, so the file reads behind them can leave the prompt and you will not need to read them again. Record facts as you confirm them; write your answer from them. The harness checks quoted text against the cited lines and corrects the line numbers when they are off.',
      parameters: {
        type: 'object',
        properties: {
          claim: {
            type: 'string',
            description: `The fact, in one sentence, with exact strings quoted (max ${FINDING_CLAIM_MAX_CHARS} chars).`,
          },
          evidence: {
            type: 'string',
            description: `Where it is: path:line or path:a-b (several separated by ";"), a URL, or the exact quoted text (max ${FINDING_EVIDENCE_MAX_CHARS} chars).`,
          },
          topic: {
            type: 'string',
            description: 'Optional: which part of the request it answers (e.g. a section name).',
          },
        },
        required: ['claim', 'evidence'],
        additionalProperties: false,
      },
    },
  },
  guidance: {
    whenToUse: ['You confirmed a fact the answer needs, from a file you read or a result you saw.'],
    whenNotToUse: ['The fact is a guess, or you have not seen its evidence yet.'],
    usage: [
      'One fact per call; several calls in one turn are fine.',
      'Evidence is path:line from the line numbers read_file or grep printed, not from memory or counting.',
      'Quote the exact text in the claim: the harness checks it at the cited lines. The result says whether it was verified, corrected (cite the corrected lines) or unverified.',
    ],
  },
  risk: 'read',
  // Runs with the first batch and is not a read: recording does not count
  // toward serial-read advice.
  stage: 'skill',
  execute: async (args, ctx) => {
    const rawClaim = typeof args.claim === 'string' ? args.claim.trim() : '';
    const rawEvidence = typeof args.evidence === 'string' ? args.evidence.trim() : '';
    if (!rawClaim || !rawEvidence) return 'Error: record_finding needs both "claim" and "evidence".';
    const claim = rawClaim.slice(0, FINDING_CLAIM_MAX_CHARS);
    const evidence = rawEvidence.slice(0, FINDING_EVIDENCE_MAX_CHARS);
    const shortened = claim.length < rawClaim.length || evidence.length < rawEvidence.length;
    let check: FindingCheck;
    try {
      check = await checkFinding(claim, evidence, ctx.workspaceRoot);
    } catch {
      check = { verification: 'skipped', evidence };
    }
    return formatRecorded(check, shortened);
  },
};
