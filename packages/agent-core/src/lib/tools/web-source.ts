import { createHash } from 'node:crypto';

import { envelopeUntrustedWeb } from './web-trust';

/** Teaser kept on the prompt card after a full fetch. */
export const WEB_CARD_TEASER_CHARS = 2_000;
/** Default / max slice for sha256+offset reads. */
export const WEB_SLICE_DEFAULT_CHARS = 6_000;
export const WEB_SLICE_MAX_CHARS = 8_000;

export type WebSourceRecord = {
  sha256: string;
  url: string;
  title: string;
  content: string;
  chars: number;
};

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function extractHeadings(text: string, max = 12): string[] {
  const headings: string[] = [];
  for (const line of text.split('\n')) {
    const md = line.match(/^#{1,3}\s+(.+?)\s*$/);
    if (md?.[1]) {
      headings.push(md[1].trim());
      if (headings.length >= max) break;
      continue;
    }
    const numbered = line.match(/^(?:Depth|Range|Altitude|Speed)\b[:\s].*/i);
    if (numbered) {
      headings.push(numbered[0].trim().slice(0, 80));
      if (headings.length >= max) break;
    }
  }
  return headings;
}

export function formatWebSourceCard(input: {
  url: string;
  title: string;
  sha256: string;
  content: string;
  cached?: boolean;
}): string {
  const chars = input.content.length;
  const teaser = input.content.slice(0, WEB_CARD_TEASER_CHARS);
  const headings = extractHeadings(input.content);
  const remaining = Math.max(0, chars - teaser.length);
  const lines = [
    '## Source',
    `URL: ${input.url}`,
    `title: ${input.title || '(untitled)'}`,
    `sha256: ${input.sha256}`,
    `chars: ${chars}`,
    ...(headings.length > 0 ? [`headings: ${headings.join(' | ')}`] : []),
    `slice: 0–${teaser.length} of ${chars}`,
    ...(input.cached ? ['note: served from run cache (no network)'] : []),
    '',
    envelopeUntrustedWeb('web_fetch', input.url, teaser),
  ];
  if (remaining > 0) {
    lines.push('');
    lines.push(
      `More: ${remaining} chars not shown. web_fetch sha256=${input.sha256} query="<words on the page>" jumps to the part you need; offset=${teaser.length} reads on in order. Do not refetch the URL for more text.`,
    );
  }
  return lines.join('\n');
}

export function formatWebSourceSlice(input: {
  url: string;
  title: string;
  sha256: string;
  content: string;
  offset: number;
  limit: number;
}): string {
  const chars = input.content.length;
  const offset = Math.max(0, Math.min(input.offset, chars));
  const limit = Math.min(
    Math.max(1, input.limit),
    WEB_SLICE_MAX_CHARS,
    Math.max(0, chars - offset),
  );
  const slice = input.content.slice(offset, offset + limit);
  const end = offset + slice.length;
  const remaining = Math.max(0, chars - end);
  const lines = [
    '## Source slice',
    `URL: ${input.url}`,
    `title: ${input.title || '(untitled)'}`,
    `sha256: ${input.sha256}`,
    `chars: ${chars}`,
    `slice: ${offset}–${end} of ${chars}`,
    '',
    envelopeUntrustedWeb('web_fetch', input.url, slice),
  ];
  if (remaining > 0) {
    lines.push('');
    lines.push(
      `More: ${remaining} chars remain. web_fetch sha256=${input.sha256} query="<words on the page>" jumps to a section; offset=${end} reads on in order.`,
    );
  } else {
    lines.push('');
    lines.push('End of source.');
  }
  return lines.join('\n');
}

/** Lines of context around each query hit. */
const WEB_QUERY_CONTEXT_LINES = 2;
/** Long lines (minified or unwrapped pages) are clipped around the hit. */
const WEB_QUERY_LINE_MAX_CHARS = 400;
export const WEB_QUERY_MIN_TERM_CHARS = 3;

function queryTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/\s+/)
        .map((term) => term.trim())
        .filter((term) => term.length >= WEB_QUERY_MIN_TERM_CHARS),
    ),
  ];
}

function clipAround(line: string, at: number): string {
  if (line.length <= WEB_QUERY_LINE_MAX_CHARS) return line;
  const half = WEB_QUERY_LINE_MAX_CHARS / 2;
  const from = Math.max(0, Math.min(at - half, line.length - WEB_QUERY_LINE_MAX_CHARS));
  const to = from + WEB_QUERY_LINE_MAX_CHARS;
  return `${from > 0 ? '…' : ''}${line.slice(from, to)}${to < line.length ? '…' : ''}`;
}

/**
 * Find-in-source for a stored page: the lines matching any query term, with
 * a little context and their char offsets, so the model jumps to what it
 * needs instead of paging the whole source. Extractive; no model call.
 */
export function formatWebSourceMatches(input: {
  url: string;
  title: string;
  sha256: string;
  content: string;
  query: string;
}): string {
  const terms = queryTerms(input.query);
  const head = [
    '## Source matches',
    `URL: ${input.url}`,
    `title: ${input.title || '(untitled)'}`,
    `sha256: ${input.sha256}`,
    `chars: ${input.content.length}`,
  ];
  if (terms.length === 0) {
    return [
      ...head,
      '',
      `query "${input.query}" has no term of ${WEB_QUERY_MIN_TERM_CHARS}+ characters. Use words that appear on the page.`,
    ].join('\n');
  }

  const lines = input.content.split('\n');
  const starts: number[] = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }
  const hitAt = lines.map((line) => {
    const lower = line.toLowerCase();
    let first = -1;
    for (const term of terms) {
      const index = lower.indexOf(term);
      if (index >= 0 && (first < 0 || index < first)) first = index;
    }
    return first;
  });
  const hits = hitAt.flatMap((index, line) => (index >= 0 ? [line] : []));

  if (hits.length === 0) {
    const headings = extractHeadings(input.content);
    return [
      ...head,
      '',
      `0 matches for "${input.query}".`,
      ...(headings.length > 0 ? [`headings: ${headings.join(' | ')}`] : []),
    ].join('\n');
  }

  // Merge overlapping context windows into passages.
  const passages: Array<[number, number]> = [];
  for (const line of hits) {
    const from = Math.max(0, line - WEB_QUERY_CONTEXT_LINES);
    const to = Math.min(lines.length - 1, line + WEB_QUERY_CONTEXT_LINES);
    const last = passages.at(-1);
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else passages.push([from, to]);
  }

  const rendered: string[] = [];
  let used = 0;
  let shown = 0;
  for (const [from, to] of passages) {
    const body: string[] = [];
    for (let i = from; i <= to; i++) {
      const line = lines[i] ?? '';
      body.push(clipAround(line, Math.max(0, hitAt[i] ?? 0)));
    }
    const block = `@offset ${starts[from]}\n${body.join('\n')}`;
    if (shown > 0 && used + block.length > WEB_SLICE_MAX_CHARS) break;
    rendered.push(block);
    used += block.length + 2;
    shown += 1;
  }

  const more =
    shown < passages.length
      ? `\n\n${passages.length - shown} more passages not shown; narrow the query.`
      : '';
  return [
    ...head,
    `matches: ${hits.length} lines in ${passages.length} passages (terms: ${terms.join(', ')})`,
    '',
    envelopeUntrustedWeb('web_fetch', input.url, rendered.join('\n\n')),
  ].join('\n') + more;
}

/** Compact stub that keeps the resume pointer for old web cards/slices. */
export function stubWebSourceCard(content: string, toolCallId: string): string | null {
  if (!content.includes('sha256:') || !content.includes('URL: ')) return null;
  const url = content.match(/^URL: (.+)$/m)?.[1]?.trim();
  const sha = content.match(/^sha256: ([a-f0-9]{64})$/m)?.[1]?.trim();
  const chars = content.match(/^chars: (\d+)$/m)?.[1]?.trim();
  const title = content.match(/^title: (.+)$/m)?.[1]?.trim();
  if (!url || !sha) return null;
  return [
    `(stub) tool ${toolCallId} web source card kept`,
    `URL: ${url}`,
    ...(title ? [`title: ${title}`] : []),
    `sha256: ${sha}`,
    ...(chars ? [`chars: ${chars}`] : []),
    `Resume: web_fetch sha256=${sha} offset=0 limit=${WEB_SLICE_DEFAULT_CHARS}`,
  ].join('\n');
}
