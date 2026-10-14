/** Last provider-measured window fill for a thread (prompt + completion). */

export type ContextAnchor = {
  occupiedTokens: number;
  model: string;
  measuredAt: string;
};

function storageKey(threadId: string): string {
  return `agenticbot:contextAnchor:${threadId}`;
}

export function occupiedFromUsage(usage: {
  promptTokens: number;
  completionTokens: number;
}): number {
  return usage.promptTokens + usage.completionTokens;
}

export function getContextAnchor(threadId: string): ContextAnchor | null {
  try {
    const raw = localStorage.getItem(storageKey(threadId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      occupiedTokens?: unknown;
      promptTokens?: unknown;
      model?: unknown;
      measuredAt?: unknown;
    };
    const occupied =
      typeof parsed.occupiedTokens === 'number'
        ? parsed.occupiedTokens
        : parsed.promptTokens;
    if (
      typeof occupied !== 'number' ||
      !Number.isFinite(occupied) ||
      typeof parsed.model !== 'string' ||
      !parsed.model ||
      typeof parsed.measuredAt !== 'string'
    ) {
      return null;
    }
    return {
      occupiedTokens: occupied,
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
