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
      `Next: web_fetch with sha256=${input.sha256} offset=${teaser.length} limit=${WEB_SLICE_DEFAULT_CHARS} (${remaining} chars remain). Do not refetch the URL for more text.`,
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
      `Next: web_fetch with sha256=${input.sha256} offset=${end} limit=${WEB_SLICE_DEFAULT_CHARS} (${remaining} chars remain).`,
    );
  } else {
    lines.push('');
    lines.push('End of source.');
  }
  return lines.join('\n');
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
