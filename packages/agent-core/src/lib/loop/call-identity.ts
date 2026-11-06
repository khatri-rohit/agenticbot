import path from 'node:path';

import { sha256Text } from '../tools/web/source';
import { canonicalizeWebFetchUrl } from '../tools/web/url';

/**
 * How the loop tells tool calls apart: the same call made twice, the same
 * outcome seen twice, and the file a call is about. Argument order, path
 * spellings (./a vs a, \ vs /) and web_fetch URL forms all collapse to one key.
 */

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function toolCallKey(toolName: string, args: unknown): string {
  if (
    toolName === 'web_fetch' &&
    args !== null &&
    typeof args === 'object' &&
    !Array.isArray(args)
  ) {
    const record = args as Record<string, unknown>;
    if (typeof record.sha256 === 'string' && record.sha256.trim()) {
      return `${toolName}:${canonicalJson({
        sha256: record.sha256.trim().toLowerCase(),
        offset: record.offset ?? 0,
        limit: record.limit ?? 0,
        query:
          typeof record.query === 'string'
            ? record.query.trim().toLowerCase()
            : '',
      })}`;
    }
    if (typeof record.url === 'string') {
      return `${toolName}:${canonicalJson({
        url: canonicalizeWebFetchUrl(record.url),
      })}`;
    }
  }
  return `${toolName}:${canonicalJson(args)}`;
}

/** Sync path key for admission/outcome maps — matches jail aliases like ./a vs a. */
function canonicalizeToolPath(raw: string): string {
  let normalized = raw.trim().replaceAll('\\', '/');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  // path.normalize keeps OS separators; re-posix so Windows matches Unix keys.
  return path.normalize(normalized || '.').split(path.sep).join('/');
}

export function pathFromToolArgs(args: unknown): string | null {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return null;
  }
  const raw = (args as Record<string, unknown>).path;
  return typeof raw === 'string' && raw.trim() ? canonicalizeToolPath(raw) : null;
}

/**
 * Outcome key for mutate/exec stuck detection. edit_file keys on path+result
 * so varied failing spans on the same file accumulate; run_terminal keys on
 * the exit-code prefix (cwd + exit/signal line) so two builds with the same
 * first error but different file counts don't falsely match; other tools keep
 * call+result (repeat guard already covers identical args).
 */
export function outcomeKey(toolName: string, args: unknown, result: string): string {
  if (toolName === 'edit_file') {
    const filePath = pathFromToolArgs(args) ?? toolCallKey(toolName, args);
    return `${toolName}:${filePath}#${sha256Text(result.slice(0, 2000))}`;
  }
  if (toolName === 'run_terminal') {
    // Result format: "cwd: <path>\nexit <code>\n<body>" / "cwd: <path>\nsignal <n>\n<body>"
    // Hash the first two lines (cwd + status) — the exit-code-bearing prefix.
    // Two runs with the same exit code but different output bodies are progress
    // (different errors being fixed); same exit code + same cwd 3× = stuck.
    const newlineIdx = result.indexOf('\n');
    const prefix =
      newlineIdx === -1
        ? result
        : result.slice(0, result.indexOf('\n', newlineIdx + 1));
    return `${toolCallKey(toolName, args)}#${sha256Text(prefix)}`;
  }
  return `${toolCallKey(toolName, args)}#${sha256Text(result.slice(0, 2000))}`;
}

