/** Normalize and jail public http(s) URLs for web_fetch / repeat-call keys. */

const READER_PREFIXES = ['https://r.jina.ai/', 'http://r.jina.ai/'];

export function looksLikeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Same page for repeat-detection: unwrap known reader hosts, drop hash,
 * drop a trailing slash. Query strings stay — they can change the document.
 */
export function canonicalizeWebFetchUrl(raw: string): string {
  const trimmed = raw.trim();
  let inner = trimmed;
  for (const prefix of READER_PREFIXES) {
    if (inner.toLowerCase().startsWith(prefix)) {
      inner = inner.slice(prefix.length);
      break;
    }
  }
  if (!looksLikeHttpUrl(inner)) return trimmed;
  const url = new URL(inner);
  url.hash = '';
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.href;
}

export function assertPublicHttpUrl(raw: string): URL {
  const url = new URL(canonicalizeWebFetchUrl(raw));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('URL must use http:// or https://');
  }
  if (isBlockedFetchHost(url.hostname)) {
    throw new Error(`Refusing to fetch private or local host: ${url.hostname}`);
  }
  return url;
}

function isBlockedFetchHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  if (
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  ) {
    return true;
  }

  if (host.includes(':')) {
    const ipv6 = host.replace(/^\[|\]$/g, '');
    if (
      ipv6 === '::1' ||
      ipv6.startsWith('fc') ||
      ipv6.startsWith('fd') ||
      ipv6.startsWith('fe80')
    ) {
      return true;
    }
  }

  const ipv4 = host.includes('.') && host.split('.').map(Number);
  if (
    ipv4 &&
    ipv4.length === 4 &&
    ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  ) {
    const [a, b] = ipv4;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }

  return false;
}
