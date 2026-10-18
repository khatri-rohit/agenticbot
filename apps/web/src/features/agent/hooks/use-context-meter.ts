'use client';

import { useEffect, useState } from 'react';
import type {
  ContextReport,
  ContextReportLayer,
  MessageAttachment,
} from '@org/agent-models';
import {
  fetchContextEstimate,
  type ComposerOptions,
} from '@/features/agent/api/agent-client';
import { getContextAnchor } from '@/features/agent/lib/context-anchor';
import { estimateDraftTokens } from '@/lib/estimate-tokens';
import { OLLAMA_MODELS } from '@/lib/ollama-models';

/** Stable empty list — never use `= []` in hook args (new ref every render → effect loop). */
const EMPTY_ATTACHMENTS: MessageAttachment[] = [];

export type ContextMeterSource = 'estimate' | 'measured';

export type ContextMeter = {
  used: number;
  limit: number | null;
  source: ContextMeterSource;
  approximate: boolean;
  layers: ContextReportLayer[];
};

export function useContextMeter(options: {
  threadId?: string;
  draft: string;
  pendingAttachments: MessageAttachment[];
  queuedContent?: string | null;
  queuedAttachments?: MessageAttachment[];
  streamingContent?: string | null;
  composerOptions: ComposerOptions;
  contextLimit: number | null;
  liveOccupiedTokens?: number;
  /** Last measured usage already includes the current streaming text. */
  occupiedCoversStream?: boolean;
  liveEstimatedPromptTokens?: number;
  liveContextReport?: ContextReport;
  liveRunModel?: string;
}): ContextMeter {
  const {
    threadId,
    draft,
    pendingAttachments,
    queuedContent,
    queuedAttachments: queuedAttachmentsOption,
    streamingContent,
    composerOptions,
    contextLimit,
    liveOccupiedTokens,
    occupiedCoversStream = false,
    liveEstimatedPromptTokens,
    liveContextReport,
    liveRunModel,
  } = options;
  const queuedAttachments = queuedAttachmentsOption ?? EMPTY_ATTACHMENTS;

  const [serverEstimate, setServerEstimate] = useState<{
    tokens: number;
    layers: ContextReportLayer[];
  } | null>(null);

  const sameModel =
    liveRunModel === undefined || liveRunModel === composerOptions.model;
  const liveOccupied =
    sameModel && liveOccupiedTokens !== undefined ? liveOccupiedTokens : null;
  const liveEstimated =
    sameModel && liveEstimatedPromptTokens !== undefined
      ? liveEstimatedPromptTokens
      : null;
  const liveLayers =
    sameModel && liveContextReport ? liveContextReport.layers : [];

  const persisted =
    liveOccupied == null && liveEstimated == null && threadId
      ? getContextAnchor(threadId)
      : null;
  const persistedOccupied =
    persisted && persisted.model === composerOptions.model
      ? persisted.occupiedTokens
      : null;

  const composerTokens = estimateDraftTokens(
    [draft, queuedContent].filter(Boolean).join('\n') || null,
    pendingAttachments.length + queuedAttachments.length,
  );
  const streamingTokens = occupiedCoversStream
    ? 0
    : estimateDraftTokens(streamingContent);

  const hasAnchor = liveOccupied != null || persistedOccupied != null;

  useEffect(() => {
    if (hasAnchor || liveEstimated != null) {
      setServerEstimate(null);
      return;
    }

    const combinedDraft = [draft, queuedContent].filter(Boolean).join('\n');
    const attachmentCount =
      pendingAttachments.length + queuedAttachments.length;
    // Idle home / empty composer: local char estimate is enough; skip hammering API.
    if (!threadId && !combinedDraft && attachmentCount === 0) {
      setServerEstimate(null);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void fetchContextEstimate({
        threadId,
        draft: combinedDraft,
        attachments: [...pendingAttachments, ...queuedAttachments],
        model: composerOptions.model,
        local: composerOptions.local,
        webSearch: composerOptions.webSearch,
      })
        .then((res) => {
          if (!cancelled) {
            setServerEstimate({
              tokens: res.estimatedPromptTokens,
              layers: res.contextReport.layers,
            });
          }
        })
        .catch(() => {
          if (!cancelled) setServerEstimate(null);
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    hasAnchor,
    liveEstimated,
    threadId,
    draft,
    pendingAttachments,
    queuedContent,
    queuedAttachments,
    composerOptions.model,
    composerOptions.local,
    composerOptions.webSearch,
  ]);

  const limit =
    contextLimit ??
    OLLAMA_MODELS.find((m) => m.id === composerOptions.model)?.contextLength ??
    null;

  if (liveOccupied != null) {
    const extra = composerTokens + streamingTokens;
    return {
      used: liveOccupied + extra,
      limit,
      source: 'measured',
      approximate: extra > 0,
      layers: liveLayers,
    };
  }

  if (liveEstimated != null) {
    return {
      used: liveEstimated + composerTokens + streamingTokens,
      limit,
      source: 'estimate',
      approximate: true,
      layers: liveLayers,
    };
  }

  if (persistedOccupied != null) {
    return {
      used: persistedOccupied + composerTokens,
      limit,
      source: 'measured',
      approximate: composerTokens > 0,
      layers: liveLayers,
    };
  }

  if (serverEstimate != null) {
    return {
      used: serverEstimate.tokens + streamingTokens,
      limit,
      source: 'estimate',
      approximate: true,
      layers: serverEstimate.layers,
    };
  }

  return {
    used: composerTokens + streamingTokens,
    limit,
    source: 'estimate',
    approximate: true,
    layers: [],
  };
}
