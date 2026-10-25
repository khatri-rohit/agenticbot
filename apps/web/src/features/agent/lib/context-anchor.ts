/** Last provider-measured window fill for a thread (prompt tokens). */

import type {
  ContextReportLayer,
  ContextWindowSource,
} from '@agent/agent-models';

export type ContextAnchor = {
  occupiedTokens: number;
  model: string;
  measuredAt: string;
  /** Assembler window used when this occupancy was measured. */
  windowTokens?: number;
  windowSource?: ContextWindowSource;
  /** Last assembled layer split; idle meter uses this until estimate returns. */
  layers?: ContextReportLayer[];
  reserve?: number;
};

function parseLayers(value: unknown): ContextReportLayer[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const layers: ContextReportLayer[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { id?: unknown; label?: unknown; tokens?: unknown };
    if (
      typeof row.id !== 'string' ||
      !row.id ||
      typeof row.label !== 'string' ||
      typeof row.tokens !== 'number' ||
      !Number.isFinite(row.tokens)
    ) {
      continue;
    }
    layers.push({ id: row.id, label: row.label, tokens: row.tokens });
  }
  return layers.length > 0 ? layers : undefined;
}

function storageKey(threadId: string): string {
  return `desk:contextAnchor:${threadId}`;
}

export function getContextAnchor(threadId: string): ContextAnchor | null {
  try {
    const raw = localStorage.getItem(storageKey(threadId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      occupiedTokens?: unknown;
      model?: unknown;
      measuredAt?: unknown;
      windowTokens?: unknown;
      windowSource?: unknown;
      layers?: unknown;
      reserve?: unknown;
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
    const windowTokens =
      typeof parsed.windowTokens === 'number' &&
      Number.isFinite(parsed.windowTokens) &&
      parsed.windowTokens > 0
        ? parsed.windowTokens
        : undefined;
    const windowSource =
      parsed.windowSource === 'show' || parsed.windowSource === 'default'
        ? parsed.windowSource
        : undefined;
    const layers = parseLayers(parsed.layers);
    const reserve =
      typeof parsed.reserve === 'number' &&
      Number.isFinite(parsed.reserve) &&
      parsed.reserve >= 0
        ? parsed.reserve
        : undefined;
    return {
      occupiedTokens: parsed.occupiedTokens,
      model: parsed.model,
      measuredAt: parsed.measuredAt,
      ...(windowTokens !== undefined ? { windowTokens } : {}),
      ...(windowSource !== undefined ? { windowSource } : {}),
      ...(layers ? { layers } : {}),
      ...(reserve !== undefined ? { reserve } : {}),
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
