import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

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

  /** Trust URLs the user wrote and sources earlier tool results named. */
  seed(messages: ChatCompletionMessageParam[]): void {
    for (const message of messages) {
      if (typeof message.content !== 'string') continue;
      if (message.role === 'user') {
        this.noteTrustedUrls(extractHttpUrls(message.content));
      } else if (message.role === 'tool') {
        this.noteTrustedUrls(hostListedWebUrls(message.content));
        const sha = message.content.match(/^sha256: ([a-f0-9]{64})$/m)?.[1];
        const url = message.content.match(/^URL: (.+)$/m)?.[1]?.trim();
        const title = message.content.match(/^title: (.+)$/m)?.[1]?.trim();
        if (sha) {
          const id = sha.toLowerCase();
          this.trustedShas.add(id);
          if (url) {
            const canonical = canonicalizeWebFetchUrl(url);
            this.meta.set(id, { url: canonical, title: title ?? '' });
            this.urlToSha.set(canonical, id);
            this.noteTrustedUrls([canonical]);
          }
        }
      }
    }
  }

  noteTrustedUrls(urls: string[]): void {
    for (const raw of urls) {
      const trimmed = raw.trim();
      if (!looksLikeHttpUrl(trimmed)) continue;
      this.trustedUrls.add(canonicalizeWebFetchUrl(trimmed));
    }
  }

  noteSource(source: WebSource): void {
    const sha = source.sha256.toLowerCase();
    this.trustedShas.add(sha);
    this.bodies.set(sha, source.content);
    this.meta.set(sha, {
      url: canonicalizeWebFetchUrl(source.url),
      title: source.title,
    });
    this.urlToSha.set(canonicalizeWebFetchUrl(source.url), sha);
    this.noteTrustedUrls([source.url]);
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
