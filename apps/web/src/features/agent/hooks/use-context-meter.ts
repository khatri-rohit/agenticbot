'use client';

import { useEffect, useRef, useState } from 'react';
import type {
  ContextReport,
  ContextReportLayer,
  ContextWindowSource,
  MessageAttachment,
} from '@agent/agent-models';
import {
  fetchContextEstimate,
  type ComposerOptions,
  type ComposerSkillHints,
} from '@/features/agent/api/agent-client';
import { getContextAnchor } from '@/features/agent/lib/context-anchor';
import { estimateDraftTokens } from '@/lib/estimate-tokens';

/** Stable empty list — never use `= []` in hook args (new ref every render → effect loop). */
const EMPTY_ATTACHMENTS: MessageAttachment[] = [];

/** Backend assemble only when draft grows by this much since the last estimate. */
const DRAFT_ESTIMATE_CHAR_THRESHOLD = 2000;

export type ContextMeterSource = 'estimate' | 'measured';

export type ContextMeter = {
  used: number;
  limit: number | null;
  source: ContextMeterSource;
  approximate: boolean;
  layers: ContextReportLayer[];
  reserve: number;
  /** Assembler window provenance when known; catalog soft-fallback leaves this unset. */
  windowSource?: ContextWindowSource;
};

export function useContextMeter(options: {
  threadId?: string;
  draft: string;
  pendingAttachments: MessageAttachment[];
  queuedContent?: string | null;
  queuedAttachments?: MessageAttachment[];
  streamingContent?: string | null;
  composerOptions: ComposerOptions;
  /** Soft fallback only until live report or /context/estimate returns. */
  contextLimit: number | null;
  liveOccupiedTokens?: number;
  /** Last measured usage already includes the current streaming text. */
  occupiedCoversStream?: boolean;
  liveEstimatedPromptTokens?: number;
  liveContextReport?: ContextReport;
  liveRunModel?: string;
  skillHints?: ComposerSkillHints;
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
    skillHints,
  } = options;
  const queuedAttachments = queuedAttachmentsOption ?? EMPTY_ATTACHMENTS;

  const [serverEstimate, setServerEstimate] = useState<{
    tokens: number;
    layers: ContextReportLayer[];
    reserve: number;
    windowTokens: number;
    windowSource?: ContextWindowSource;
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
  const liveWindowTokens =
    sameModel && liveContextReport
      ? liveContextReport.budget.windowTokens
      : null;
  const liveWindowSource =
    sameModel && liveContextReport
      ? liveContextReport.windowSource
      : undefined;

  const persisted =
    liveOccupied == null && liveEstimated == null && threadId
      ? getContextAnchor(threadId)
      : null;
  const persistedForModel =
    persisted && persisted.model === composerOptions.model ? persisted : null;
  const persistedOccupied = persistedForModel?.occupiedTokens ?? null;
  const persistedWindowTokens = persistedForModel?.windowTokens ?? null;
  const persistedWindowSource = persistedForModel?.windowSource;
  const persistedLayers = persistedForModel?.layers ?? [];
  const persistedReserve = persistedForModel?.reserve ?? 0;

  const composerTokens = estimateDraftTokens(
    [draft, queuedContent].filter(Boolean).join('\n') || null,
    pendingAttachments.length + queuedAttachments.length,
  );
  const streamingTokens = occupiedCoversStream
    ? 0
    : estimateDraftTokens(streamingContent);

  const combinedDraft = [draft, queuedContent].filter(Boolean).join('\n');
  const attachmentCount =
    pendingAttachments.length + queuedAttachments.length;
  const hasDraft = combinedDraft.length > 0 || attachmentCount > 0;

  const hasLiveReport = liveLayers.length > 0;
  const hasMeasuredAnchor =
    liveOccupied != null || liveEstimated != null || persistedOccupied != null;

  const lastEstimateDraftLen = useRef(0);
  const lastEstimateThreadId = useRef<string | undefined>(undefined);

  useEffect(() => {
    // Idle home: nothing to assemble.
    if (!threadId && !hasDraft) {
      setServerEstimate(null);
      return;
    }
    // Live/measured usage already anchors the meter; skip until a large new draft.
    if (hasLiveReport && !hasDraft) {
      return;
    }

    const threadChanged = lastEstimateThreadId.current !== threadId;
    if (threadChanged) {
      lastEstimateThreadId.current = threadId;
      lastEstimateDraftLen.current = 0;
    }

    const draftLen = combinedDraft.length;
    const crossedThreshold =
      draftLen - lastEstimateDraftLen.current >= DRAFT_ESTIMATE_CHAR_THRESHOLD;
    // Hydrate once per thread (or first draft on home). Large-paste threshold
    // while typing. Continuous draft debounce is intentionally not used —
    // measured turn usage is the source of truth for "used" context.
    const shouldEstimate =
      threadChanged ||
      (!hasMeasuredAnchor && !hasLiveReport) ||
      crossedThreshold;

    if (!shouldEstimate) {
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
        posture: composerOptions.posture,
        skills: skillHints,
      })
        .then((res) => {
          if (cancelled) return;
          lastEstimateDraftLen.current = draftLen;
          setServerEstimate({
            tokens: res.estimatedPromptTokens,
            layers: res.contextReport.layers,
            reserve: res.contextReport.budget.outputReserveTokens,
            windowTokens: res.contextReport.budget.windowTokens,
            windowSource: res.contextReport.windowSource,
          });
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
    hasLiveReport,
    hasMeasuredAnchor,
    threadId,
    hasDraft,
    combinedDraft,
    pendingAttachments,
    queuedAttachments,
    composerOptions.model,
    composerOptions.local,
    composerOptions.webSearch,
    composerOptions.posture,
    skillHints?.requested,
  ]);

  // Assembler/report window first; catalog contextLimit only until estimate lands.
  const limit =
    liveWindowTokens ??
    serverEstimate?.windowTokens ??
    persistedWindowTokens ??
    contextLimit ??
    null;
  const windowSource =
    liveWindowSource ??
    serverEstimate?.windowSource ??
    persistedWindowSource ??
    undefined;

  const liveReserve =
    liveContextReport?.budget.outputReserveTokens ??
    serverEstimate?.reserve ??
    persistedReserve;
  const layers =
    liveLayers.length > 0
      ? liveLayers
      : (serverEstimate?.layers ?? persistedLayers);

  if (liveOccupied != null) {
    const extra = composerTokens + streamingTokens;
    return {
      used: liveOccupied + extra,
      limit,
      source: 'measured',
      approximate: extra > 0,
      layers,
      reserve: liveReserve,
      windowSource,
    };
  }

  if (liveEstimated != null) {
    return {
      used: liveEstimated + composerTokens + streamingTokens,
      limit,
      source: 'estimate',
      approximate: true,
      layers,
      reserve: liveReserve,
      windowSource,
    };
  }

  if (persistedOccupied != null) {
    return {
      used: persistedOccupied + composerTokens,
      limit,
      source: 'measured',
      approximate: composerTokens > 0,
      layers,
      reserve: liveReserve,
      windowSource,
    };
  }

  if (serverEstimate != null) {
    return {
      used: serverEstimate.tokens + streamingTokens,
      limit,
      source: 'estimate',
      approximate: true,
      layers: serverEstimate.layers,
      reserve: serverEstimate.reserve,
      windowSource,
    };
  }

  return {
    used: composerTokens + streamingTokens,
    limit,
    source: 'estimate',
    approximate: true,
    layers: [],
    reserve: 0,
    windowSource,
  };
}
