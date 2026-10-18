/** Last provider-measured window fill for a thread (prompt + completion). */

export type ContextAnchor = {
  occupiedTokens: number;
  model: string;
  measuredAt: string;
};

function storageKey(threadId: string): string {
  return `agenticbot:contextAnchor:${threadId}`;
}

export function getContextAnchor(threadId: string): ContextAnchor | null {
  try {
    const raw = localStorage.getItem(storageKey(threadId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      occupiedTokens?: unknown;
      model?: unknown;
      measuredAt?: unknown;
    };
    if (
      typeof parsed.occupiedTokens !== 'number' ||
      !Number.isFinite(parsed.occupiedTokens) ||
      typeof parsed.model !== 'string' ||
      !parsed.model ||
      typeof parsed.measuredAt !== 'string'
    ) {
      return null;
    }
    return {
      occupiedTokens: parsed.occupiedTokens,
      model: parsed.model,
      measuredAt: parsed.measuredAt,
    };
  } catch {
    return null;
  }
}

export function setContextAnchor(
  threadId: string,
  anchor: ContextAnchor,
): void {
  try {
    localStorage.setItem(storageKey(threadId), JSON.stringify(anchor));
  } catch {
    /* storage blocked */
  }
}

export function clearContextAnchor(threadId: string): void {
  try {
    localStorage.removeItem(storageKey(threadId));
  } catch {
    /* storage blocked */
  }
}
