/**
 * Every way the loop refuses a tool call or stops a run carries a stable code,
 * written as `${code}: ${detail}` in tool rows and stop reasons. Readers ask
 * this table instead of matching the text themselves.
 *
 * resumable: the run left a handoff (or plan) to continue from.
 * pause: the account ran out; the work itself is fine.
 */
const LIMIT_CODES = {
  'limit.repeat': {},
  'limit.tools': { resumable: true },
  'limit.read_storm': {},
  'limit.terminal': {},
  'limit.unknown': {},
  'limit.outcome': {},
  'limit.iterations': { resumable: true },
  'limit.plan': {},
  'limit.finish': {},
  'limit.tokens': { resumable: true },
  'limit.wall': { resumable: true },
  'limit.research': { resumable: true },
  'limit.capacity': { resumable: true, pause: true },
} satisfies Record<string, { resumable?: true; pause?: true }>;

export type LimitCode = keyof typeof LIMIT_CODES;

/** Stored as the stop reason of a run the user cancelled. */
export const RUN_CANCELLED_REASON = 'Run cancelled';

/**
 * Stored when a run starts and replaced when it finishes, so a run the server
 * never finished (crash, restart) keeps this reason.
 */
export const RUN_INTERRUPTED_REASON =
  'Run interrupted: the server stopped before it finished. Files may be half-edited.';

export function limitMessage(code: LimitCode, detail: string): string {
  return `${code}: ${detail}`;
}

/** The code a tool row or stop reason starts with, if any. */
export function limitCodeOf(text: string): LimitCode | null {
  const colon = text.indexOf(':');
  if (colon < 0) return null;
  const code = text.slice(0, colon);
  return Object.hasOwn(LIMIT_CODES, code) ? (code as LimitCode) : null;
}

/** Stops that leave a handoff to continue from (not cancels, errors, or plan/finish gates). */
export function isResumableStop(reason: string): boolean {
  const code = limitCodeOf(reason);
  return code !== null && 'resumable' in LIMIT_CODES[code];
}

/** Account usage stops: the run paused rather than failed. */
export function isPauseStop(reason: string): boolean {
  const code = limitCodeOf(reason);
  return code !== null && 'pause' in LIMIT_CODES[code];
}
