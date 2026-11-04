'use client';

import { useEffect, useRef, useState } from 'react';
import type {
  ContextReportLayer,
  ContextWindowSource,
  MessageAttachment,
} from '@agent/agent-models';
import {
  fetchContextEstimate,
  type ComposerOptions,
  type ComposerSkillHints,
} from '@/api/agent-client';
import type { ChatRunState } from '@/features/conversation/chat-store';
import {
  getContextAnchor,
  type ContextAnchor,
} from '@/features/conversation/context-anchor';
import { estimateDraftTokens } from '@/features/usage/estimate-tokens';

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

type ServerEstimate = {
  tokens: number;
  layers: ContextReportLayer[];
  reserve: number;
  windowTokens: number;
  windowSource?: ContextWindowSource;
};

/**
 * Which reading the meter shows, best first: the live run's measured usage,
 * then its start estimate, then the last usage measured for the thread, then
 * the server's estimate, then the draft alone. The live run and the anchor
 * must already be for the composer's model.
 */
export function selectMeterReading(input: {
  liveRun: ChatRunState | null;
  anchor: ContextAnchor | null;
  estimate: ServerEstimate | null;
  /** Catalog window, until a report or estimate gives the assembler's. */
  contextLimit: number | null;
  composerTokens: number;
  streamingTokens: number;
}): ContextMeter {
  const { liveRun, anchor, estimate, composerTokens, streamingTokens } = input;
  const report = liveRun?.contextReport;
  const limit =
    report?.budget.windowTokens ??
    estimate?.windowTokens ??
    anchor?.windowTokens ??
    input.contextLimit ??
    null;
  const windowSource =
    report?.windowSource ?? estimate?.windowSource ?? anchor?.windowSource;
  const reserve =
    report?.budget.outputReserveTokens ?? estimate?.reserve ?? anchor?.reserve ?? 0;
  const layers = report?.layers.length
    ? report.layers
    : (estimate?.layers ?? anchor?.layers ?? []);

  if (liveRun?.occupiedTokens !== undefined) {
    const extra = composerTokens + streamingTokens;
    return {
      used: liveRun.occupiedTokens + extra,
      limit,
      source: 'measured',
      approximate: extra > 0,
      layers,
      reserve,
      windowSource,
    };
  }
  if (liveRun?.estimatedPromptTokens !== undefined) {
    return {
      used: liveRun.estimatedPromptTokens + composerTokens + streamingTokens,
      limit,
      source: 'estimate',
      approximate: true,
      layers,
      reserve,
      windowSource,
    };
  }
  if (anchor) {
    return {
      used: anchor.occupiedTokens + composerTokens,
      limit,
      source: 'measured',
      approximate: composerTokens > 0,
      layers,
      reserve,
      windowSource,
    };
  }
  if (estimate) {
    return {
      used: estimate.tokens + streamingTokens,
      limit,
      source: 'estimate',
      approximate: true,
      layers: estimate.layers,
      reserve: estimate.reserve,
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

export function useContextMeter(options: {
  threadId?: string;
  draft: string;
  pendingAttachments: MessageAttachment[];
  queuedContent?: string | null;
  queuedAttachments?: MessageAttachment[];
  composerOptions: ComposerOptions;
  /** Soft fallback only until live report or /context/estimate returns. */
  contextLimit: number | null;
  /** The thread's live run, if any. */
  liveRun: ChatRunState | null;
  skillHints?: ComposerSkillHints;
}): ContextMeter {
  const {
    threadId,
    draft,
    pendingAttachments,
    queuedContent,
    queuedAttachments: queuedAttachmentsOption,
    composerOptions,
    contextLimit,
    skillHints,
  } = options;
  const queuedAttachments = queuedAttachmentsOption ?? EMPTY_ATTACHMENTS;

  const [serverEstimate, setServerEstimate] = useState<ServerEstimate | null>(
    null,
  );

  // A run on another model says nothing about the composer's model.
  const liveRun =
    options.liveRun && options.liveRun.model === composerOptions.model
      ? options.liveRun
      : null;
  const liveUsage =
    liveRun?.occupiedTokens !== undefined ||
    liveRun?.estimatedPromptTokens !== undefined;
  const savedAnchor = !liveUsage && threadId ? getContextAnchor(threadId) : null;
  const anchor =
    savedAnchor && savedAnchor.model === composerOptions.model
      ? savedAnchor
      : null;

  const combinedDraft = [draft, queuedContent].filter(Boolean).join('\n');
  const attachmentCount = pendingAttachments.length + queuedAttachments.length;
  const hasDraft = combinedDraft.length > 0 || attachmentCount > 0;
  const composerTokens = estimateDraftTokens(
    combinedDraft || null,
    attachmentCount,
  );
  const streamingTokens = liveRun?.occupiedCoversStream
    ? 0
    : estimateDraftTokens(liveRun?.streamingMessage?.content);

  const hasLiveReport = Boolean(liveRun?.contextReport?.layers.length);

  // Success-only hydrate mark — cancel/fail leaves thread unset so we retry.
  const lastEstimateDraftLen = useRef(0);
  // Key by thread + the options that change the estimate (model, local,
  // webSearch, posture, skills, window). A change after a successful hydrate
  // must re-fetch, not serve a stale windowTokens from the old config.
  const estimateKey = `${threadId ?? ''}|${composerOptions.model ?? ''}|${composerOptions.local ?? ''}|${composerOptions.webSearch ?? ''}|${composerOptions.posture ?? ''}|${skillHints?.requested?.join(',') ?? ''}|${composerOptions.contextWindowMode ?? ''}`;
  const lastEstimateKey = useRef<string | undefined>(undefined);
  // In-flight hydrate for this key; blocks re-schedule while typing churns deps.
  const hydrateRequestedKey = useRef<string | undefined>(undefined);

  const estimateArgs = {
    threadId,
    draft: combinedDraft,
    attachments: [...pendingAttachments, ...queuedAttachments],
    model: composerOptions.model,
    local: composerOptions.local,
    webSearch: composerOptions.webSearch,
    posture: composerOptions.posture,
    skills: skillHints,
    ...(composerOptions.contextWindowMode
      ? { contextWindowMode: composerOptions.contextWindowMode }
      : {}),
  };

  // Hydrate once per estimate key (success-gated). Not tied to draft keystrokes.
  useEffect(() => {
    if (!threadId && !hasDraft) {
      setServerEstimate(null);
      return;
    }
    if (hasLiveReport && !hasDraft) return;

    const needsHydrate =
      lastEstimateKey.current !== estimateKey &&
      hydrateRequestedKey.current !== estimateKey;
    if (!needsHydrate) return;

    let cancelled = false;
    hydrateRequestedKey.current = estimateKey;
    const timer = window.setTimeout(() => {
      void fetchContextEstimate(estimateArgs)
        .then((res) => {
          if (cancelled) return;
          lastEstimateKey.current = estimateKey;
          lastEstimateDraftLen.current = combinedDraft.length;
          hydrateRequestedKey.current = undefined;
          setServerEstimate({
            tokens: res.estimatedPromptTokens,
            layers: res.contextReport.layers,
            reserve: res.contextReport.budget.outputReserveTokens,
            windowTokens: res.contextReport.budget.windowTokens,
            windowSource: res.contextReport.windowSource,
          });
        })
        .catch(() => {
          if (cancelled) return;
          hydrateRequestedKey.current = undefined;
          setServerEstimate(null);
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      // Allow retry when this attempt was aborted before success.
      if (
        hydrateRequestedKey.current === estimateKey &&
        lastEstimateKey.current !== estimateKey
      ) {
        hydrateRequestedKey.current = undefined;
      }
    };
    // Hydrate on thread/options only: draft length is left out on purpose,
    // the threshold effect below handles large pastes.
  }, [
    hasLiveReport,
    threadId,
    hasDraft,
    composerOptions.model,
    composerOptions.local,
    composerOptions.webSearch,
    composerOptions.posture,
    composerOptions.contextWindowMode,
    skillHints?.requested,
  ]);

  // Large-paste threshold only (no per-pause estimate on empty new chats).
  useEffect(() => {
    if (!threadId && !hasDraft) return;
    if (hasLiveReport && !hasDraft) return;

    const draftLen = combinedDraft.length;
    const crossedThreshold =
      draftLen - lastEstimateDraftLen.current >= DRAFT_ESTIMATE_CHAR_THRESHOLD;
    if (!crossedThreshold) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void fetchContextEstimate(estimateArgs)
        .then((res) => {
          if (cancelled) return;
          lastEstimateDraftLen.current = draftLen;
          if (lastEstimateKey.current !== estimateKey) {
            lastEstimateKey.current = estimateKey;
          }
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
    // Watches draft size; the request args are rebuilt every render.
  }, [
    hasLiveReport,
    threadId,
    hasDraft,
    combinedDraft,
    pendingAttachments,
    queuedAttachments,
    composerOptions.model,
    composerOptions.local,
    composerOptions.webSearch,
    composerOptions.posture,
    composerOptions.contextWindowMode,
    skillHints?.requested,
  ]);

  return selectMeterReading({
    liveRun,
    anchor,
    estimate: serverEstimate,
    contextLimit,
    composerTokens,
    streamingTokens,
  });
}
