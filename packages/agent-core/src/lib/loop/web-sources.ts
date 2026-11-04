import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import type { LedgerEnvelope, WebTrust } from '@agent/agent-models';

import { sha256Text } from '../tools/web/source';
import { extractHttpUrls, hostListedWebUrls } from '../tools/web/trust';
import { canonicalizeWebFetchUrl, looksLikeHttpUrl } from '../tools/web/url';

/** In-order slices of one web source between query hints. */
const WEB_SLICE_NOTE_EVERY = 3;

export type WebSource = {
  sha256: string;
  url: string;
  title: string;
  content: string;
};

const WEB_TOOLS = new Set(['web_search', 'web_fetch']);

/**
 * Trust named by the text of a web tool row written before trust was stored
 * on rows. Only for those rows: the cards are host-formatted, and page text
 * inside the untrusted fence is skipped.
 */
function webTrustFromText(content: string): WebTrust {
  const urls = hostListedWebUrls(content);
  const sha = content.match(/^sha256: ([a-f0-9]{64})$/m)?.[1];
  const url = content.match(/^URL: (.+)$/m)?.[1]?.trim();
  const title = content.match(/^title: (.+)$/m)?.[1]?.trim() ?? '';
  return { urls, sources: sha && url ? [{ sha256: sha, url, title }] : [] };
}

/**
 * Everything a thread's web tools made fetchable, across its whole ledger
 * (compaction never deletes rows, so trust outlives it; a rewind cuts it with
 * its rows). Envelopes must be hydrated for rows from before trust was stored.
 */
export function webTrustFromLedger(envelopes: LedgerEnvelope[]): WebTrust {
  const trust: WebTrust = { urls: [], sources: [] };
  const webCalls = new Set<string>();
  for (const envelope of envelopes) {
    const record = envelope.record;
    if (record.role === 'assistant') {
      for (const call of record.tool_calls ?? []) {
        if (WEB_TOOLS.has(call.function.name)) webCalls.add(call.id);
      }
      continue;
    }
    if (record.role !== 'tool') continue;
    // Rows written since outcomes were stored carry their trust (or none).
    const rowTrust =
      envelope.webTrust ??
      (!envelope.toolOutcome && webCalls.has(record.tool_call_id)
        ? webTrustFromText(record.content)
        : undefined);
    if (!rowTrust) continue;
    trust.urls.push(...rowTrust.urls);
    trust.sources.push(...rowTrust.sources);
  }
  return trust;
}

/**
 * The web sources a run may read. web_fetch only reaches a URL the user gave
 * or web_search returned, or a sha256 stored on this run (or named in an
 * earlier tool result); bodies are cached here and kept in the host's blob
 * store when it has one.
 */
export class WebSourceStore {
  private readonly trustedUrls = new Set<string>();
  private readonly trustedShas = new Set<string>();
  private readonly bodies = new Map<string, string>();
  private readonly meta = new Map<string, { url: string; title: string }>();
  private readonly urlToSha = new Map<string, string>();
  private readonly slicesBySha = new Map<string, number>();

  constructor(
    private readonly host: {
      putBlob?: (text: string) => Promise<string>;
      readBlob?: (sha256: string, offset?: number, length?: number) => Promise<string>;
    },
  ) {}

  /**
   * Trust URLs the user wrote, plus what earlier web calls made fetchable:
   * `trust` when the host read it from the ledger, else the text of the web
   * tool rows in `messages`. No other tool's text can make a URL fetchable.
   */
  seed(messages: ChatCompletionMessageParam[], trust?: WebTrust): void {
    const webCalls = new Set<string>();
    for (const message of messages) {
      if (message.role === 'assistant') {
        for (const call of message.tool_calls ?? []) {
          if (call.type === 'function' && WEB_TOOLS.has(call.function.name)) {
            webCalls.add(call.id);
          }
        }
        continue;
      }
      if (typeof message.content !== 'string') continue;
      if (message.role === 'user') {
        this.noteTrustedUrls(extractHttpUrls(message.content));
      } else if (
        !trust &&
        message.role === 'tool' &&
        webCalls.has(message.tool_call_id)
      ) {
        this.trust(webTrustFromText(message.content));
      }
    }
    if (trust) this.trust(trust);
  }

  /** What this run trusts, for a child that reads the same conversation. */
  snapshot(): WebTrust {
    return {
      urls: [...this.trustedUrls],
      sources: [...this.meta].map(([sha256, meta]) => ({ sha256, ...meta })),
    };
  }

  private trust(trust: WebTrust): void {
    this.noteTrustedUrls(trust.urls);
    for (const source of trust.sources) this.noteSourceMeta(source);
  }

  private noteSourceMeta(source: { sha256: string; url: string; title: string }): void {
    const sha = source.sha256.toLowerCase();
    const url = canonicalizeWebFetchUrl(source.url);
    this.trustedShas.add(sha);
    this.meta.set(sha, { url, title: source.title });
    this.urlToSha.set(url, sha);
    this.noteTrustedUrls([url]);
  }

  noteTrustedUrls(urls: string[]): void {
    for (const raw of urls) {
      const trimmed = raw.trim();
      if (!looksLikeHttpUrl(trimmed)) continue;
      this.trustedUrls.add(canonicalizeWebFetchUrl(trimmed));
    }
  }

  noteSource(source: WebSource): void {
    this.noteSourceMeta(source);
    this.bodies.set(source.sha256.toLowerCase(), source.content);
  }

  trustsUrl(url: string): boolean {
    return this.trustedUrls.has(canonicalizeWebFetchUrl(url));
  }

  /** `sha` must already be lower-case. */
  trustsSha(sha: string): boolean {
    return this.trustedShas.has(sha);
  }

  async putBlob(text: string): Promise<string> {
    if (this.host.putBlob) {
      const sha = (await this.host.putBlob(text)).toLowerCase();
      this.bodies.set(sha, text);
      return sha;
    }
    const sha = sha256Text(text);
    this.bodies.set(sha, text);
    return sha;
  }

  async get(sha256: string): Promise<WebSource | undefined> {
    const sha = sha256.toLowerCase();
    if (!this.trustedShas.has(sha)) return undefined;
    let content = this.bodies.get(sha);
    if (!content && this.host.readBlob) {
      content = await this.host.readBlob(sha);
      if (content) this.bodies.set(sha, content);
    }
    if (!content) return undefined;
    const meta = this.meta.get(sha) ?? { url: '', title: '' };
    return { sha256: sha, url: meta.url, title: meta.title, content };
  }

  getByUrl(url: string): string | undefined {
    return this.urlToSha.get(canonicalizeWebFetchUrl(url));
  }

  /** A stored body (or a range of it), from this run's cache or the host's blob store. */
  async readBlob(sha: string, offset?: number, length?: number): Promise<string> {
    const key = sha.toLowerCase();
    const cached = (await this.get(key))?.content ?? this.bodies.get(key);
    if (cached !== undefined) {
      if (offset === undefined && length === undefined) return cached;
      const start = offset ?? 0;
      return cached.slice(start, length === undefined ? undefined : start + length);
    }
    if (!this.host.readBlob) throw new Error(`Blob not found: ${sha}`);
    return this.host.readBlob(key, offset, length);
  }

  /**
   * Count one in-order slice of a source (web_fetch by sha, no query).
   * Returns the count when it is time to point the model at query=.
   */
  sliceNoteDue(args: Record<string, unknown>, result: string): number | undefined {
    const sha = typeof args.sha256 === 'string' ? args.sha256.trim().toLowerCase() : '';
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!sha || query || !result.startsWith('## Source slice')) return undefined;
    const count = (this.slicesBySha.get(sha) ?? 0) + 1;
    this.slicesBySha.set(sha, count);
    return count % WEB_SLICE_NOTE_EVERY === 0 ? count : undefined;
  }
}
