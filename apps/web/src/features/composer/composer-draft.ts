import type { MessageAttachment } from '@agent/agent-models';
import { isThreadMention } from '@agent/agent-models';

/** Unsent composer text and attachments, kept per thread across reloads. */
export type ComposerDraft = {
  content: string;
  attachments: MessageAttachment[];
};

function isPersistedAttachment(value: unknown): value is MessageAttachment {
  if (!value || typeof value !== 'object') return false;
  const rec = value as MessageAttachment;
  if (isThreadMention(rec)) {
    return (
      typeof rec.id === 'string' &&
      typeof rec.threadId === 'string' &&
      typeof rec.title === 'string'
    );
  }
  return (
    typeof rec.id === 'string' &&
    typeof rec.mimeType === 'string' &&
    typeof rec.dataUrl === 'string'
  );
}

function draftStorageKey(scope: string): string {
  return `agent:composerDraft:${scope}`;
}

export function loadComposerDraft(scope: string): ComposerDraft | null {
  try {
    const raw = localStorage.getItem(draftStorageKey(scope));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      content?: unknown;
      attachments?: unknown;
    };
    const content = typeof parsed.content === 'string' ? parsed.content : '';
    const attachments = Array.isArray(parsed.attachments)
      ? parsed.attachments.filter(isPersistedAttachment)
      : [];
    if (!content.trim() && attachments.length === 0) return null;
    return { content, attachments };
  } catch {
    return null;
  }
}

export function saveComposerDraft(scope: string, draft: ComposerDraft): void {
  if (!draft.content.trim() && draft.attachments.length === 0) {
    try {
      localStorage.removeItem(draftStorageKey(scope));
    } catch {
      /* storage blocked */
    }
    return;
  }
  try {
    localStorage.setItem(draftStorageKey(scope), JSON.stringify(draft));
  } catch {
    // Quota: keep text if images do not fit.
    if (draft.attachments.length > 0 && draft.content.trim()) {
      try {
        localStorage.setItem(
          draftStorageKey(scope),
          JSON.stringify({ content: draft.content, attachments: [] }),
        );
      } catch {
        /* storage blocked */
      }
    }
  }
}

export function clearComposerDraft(scope: string): void {
  try {
    localStorage.removeItem(draftStorageKey(scope));
  } catch {
    /* storage blocked */
  }
}
