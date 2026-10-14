'use client';

import { useEffect, useState } from 'react';
import type {
  ChatMessage,
  Message,
  MessageAttachment,
} from '@org/agent-models';
import {
  fetchContextEstimate,
  type ComposerOptions,
} from '@/features/agent/api/agent-client';
import { getContextAnchor } from '@/features/agent/lib/context-anchor';
import { toChatContext } from '@/features/agent/lib/to-chat-context';
import { estimateDraftTokens } from '@/lib/estimate-tokens';
import { getUserPersona } from '@/lib/user-persona';
import { OLLAMA_MODELS } from '@/lib/ollama-models';

export type ContextMeterSource = 'estimate' | 'measured';

export type ContextMeter = {
  used: number;
  limit: number | null;
  source: ContextMeterSource;
  approximate: boolean;
};

function draftAsChatMessages(
  draft: string,
  attachments: MessageAttachment[],
): ChatMessage[] {
  const trimmed = draft.trim();
  if (!trimmed && attachments.length === 0) return [];
  return toChatContext([
    {
      id: 'draft',
      threadId: 'draft',
      runId: null,
      role: 'user',
      content: trimmed,
      status: 'complete',
      createdAt: '',
      attachments: attachments.length > 0 ? attachments : undefined,
    },
  ]);
}

export function useContextMeter(options: {
  threadId?: string;
  messages: Message[];
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
  liveRunModel?: string;
}): ContextMeter {
  const {
    threadId,
    messages,
    draft,
    pendingAttachments,
    queuedContent,
    queuedAttachments = [],
    streamingContent,
    composerOptions,
    contextLimit,
    liveOccupiedTokens,
    occupiedCoversStream = false,
    liveEstimatedPromptTokens,
    liveRunModel,
  } = options;

  const userPersona = getUserPersona();
  const [serverEstimate, setServerEstimate] = useState<number | null>(null);

  const sameModel =
    liveRunModel === undefined || liveRunModel === composerOptions.model;
  const liveOccupied =
    sameModel && liveOccupiedTokens !== undefined ? liveOccupiedTokens : null;
  const liveEstimated =
    sameModel && liveEstimatedPromptTokens !== undefined
      ? liveEstimatedPromptTokens
      : null;

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

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void fetchContextEstimate({
        messages: [
          ...toChatContext(messages),
          ...draftAsChatMessages(draft, pendingAttachments),
          ...draftAsChatMessages(queuedContent ?? '', queuedAttachments),
        ],
        model: composerOptions.model,
        webSearch: composerOptions.webSearch,
        userPersona,
      })
        .then((res) => {
          if (!cancelled) setServerEstimate(res.estimatedPromptTokens);
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
    messages,
    draft,
    pendingAttachments,
    queuedContent,
    queuedAttachments,
    composerOptions.model,
    composerOptions.webSearch,
    userPersona,
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
    };
  }

  if (liveEstimated != null) {
    return {
      used: liveEstimated + composerTokens + streamingTokens,
      limit,
      source: 'estimate',
      approximate: true,
    };
  }

  if (persistedOccupied != null) {
    return {
      used: persistedOccupied + composerTokens,
      limit,
      source: 'measured',
      approximate: composerTokens > 0,
    };
  }

  if (serverEstimate != null) {
    return {
      used: serverEstimate + streamingTokens,
      limit,
      source: 'estimate',
      approximate: true,
    };
  }

  return {
    used: composerTokens + streamingTokens,
    limit,
    source: 'estimate',
    approximate: true,
  };
}
