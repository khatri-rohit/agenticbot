'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message } from '@agent/agent-models';
import { imageAttachments, threadMentions } from '@agent/agent-models';
import { ThreadMentionChip } from '@/components/thread-mention-picker';
import { MessageActions } from '@/components/message-actions';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { formatMessageTime } from '@/lib/format-relative-time';

export function UserMessage({
  message,
  canEdit,
  hasResponseBelow,
  onEditSubmit,
}: {
  message: Message;
  canEdit: boolean;
  hasResponseBelow: boolean;
  onEditSubmit: (messageId: string, content: string) => void | Promise<void>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [confirmClear, setConfirmClear] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!isEditing) setDraft(message.content);
  }, [message.content, isEditing]);

  useEffect(() => {
    if (isEditing) textareaRef.current?.focus();
  }, [isEditing]);

  const startEdit = useCallback(() => {
    setDraft(message.content);
    setConfirmClear(false);
    setIsEditing(true);
  }, [message.content]);

  const cancelEdit = useCallback(() => {
    setIsEditing(false);
    setConfirmClear(false);
    setDraft(message.content);
  }, [message.content]);

  const hasAttachments = (message.attachments?.length ?? 0) > 0;
  const canResend = Boolean(draft.trim()) || hasAttachments;
  const sentAt = formatMessageTime(message.createdAt);

  const runSubmit = useCallback(async () => {
    const trimmed = draft.trim();
    if ((!trimmed && !hasAttachments) || submitting) return;
    setSubmitting(true);
    try {
      await onEditSubmit(message.id, trimmed);
      setIsEditing(false);
      setConfirmClear(false);
    } finally {
      setSubmitting(false);
    }
  }, [draft, hasAttachments, message.id, onEditSubmit, submitting]);

  const handleResend = useCallback(() => {
    if (!canResend) return;
    if (hasResponseBelow) {
      setConfirmClear(true);
      return;
    }
    void runSubmit();
  }, [canResend, hasResponseBelow, runSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelEdit();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleResend();
      }
    },
    [cancelEdit, handleResend],
  );

  return (
    <div
      className="min-w-0 max-w-full"
    >
      {isEditing ? (
        <div
          className="rounded-lg bg-muted/45 p-3 ring-1 ring-border/40"
          role="form"
          aria-label="Edit message"
        >
          {message.attachments && message.attachments.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-1.5 px-0.5">
              {threadMentions(message.attachments).map((mention) => (
                <ThreadMentionChip key={mention.id} mention={mention} />
              ))}
              {imageAttachments(message.attachments).map((attachment) => (
                <img
                  key={attachment.id}
                  src={attachment.dataUrl}
                  alt={attachment.name ?? 'Attachment'}
                  className="size-14 rounded-lg object-cover ring-1 ring-border/40"
                />
              ))}
            </div>
          ) : null}
          <Textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={4}
            className="type-user h-24 min-h-24 resize-none border-0 bg-transparent px-1 py-1 shadow-none focus-visible:ring-0"
          />
          {confirmClear ? (
            <div
              className="mt-2 space-y-2 rounded-lg bg-background/60 px-3 py-2.5 ring-1 ring-border/50"
              role="alertdialog"
              aria-labelledby={`edit-clear-title-${message.id}`}
            >
              <p
                id={`edit-clear-title-${message.id}`}
                className="type-ui text-foreground/90"
              >
                Resending will remove the assistant response for this turn.
              </p>
              <p className="type-caption text-muted-foreground">
                Your edited prompt will be sent again from this point in the
                thread.
              </p>
              <div className="flex flex-wrap justify-end gap-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={submitting}
                  onClick={() => setConfirmClear(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={submitting || !canResend}
                  onClick={() => void runSubmit()}
                >
                  {submitting ? 'Sending…' : 'Proceed'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap justify-end gap-1.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={submitting}
                onClick={cancelEdit}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={submitting || !canResend}
                onClick={handleResend}
              >
                Resend
              </Button>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Document-style prompt card: stronger fill + bright ring so the
              user's prompt is visually distinct from assistant/code content
              while scrolling the transcript. */}
          <div
            className={cn(
              'type-user min-w-0 max-w-full overflow-hidden rounded-lg bg-muted/55 px-4 py-3 text-foreground ring-1 ring-foreground/25',
            )}
          >
            {message.attachments && message.attachments.length > 0 ? (
              <div className="mb-2.5 flex flex-wrap gap-1.5">
                {threadMentions(message.attachments).map((mention) => (
                  <ThreadMentionChip key={mention.id} mention={mention} />
                ))}
                {imageAttachments(message.attachments).map((attachment) => (
                  <button
                    key={attachment.id}
                    type="button"
                    className="block size-20 overflow-hidden rounded-lg ring-1 ring-border/40 transition hover:ring-border"
                    aria-label={attachment.name ?? 'Open attached image'}
                    onClick={() => {
                      try {
                        const [header, data] = attachment.dataUrl.split(',');
                        const mime =
                          /data:([^;]+)/.exec(header)?.[1] ??
                          'application/octet-stream';
                        const binary = atob(data ?? '');
                        const bytes = new Uint8Array(binary.length);
                        for (let i = 0; i < binary.length; i++) {
                          bytes[i] = binary.charCodeAt(i);
                        }
                        const url = URL.createObjectURL(
                          new Blob([bytes], { type: mime }),
                        );
                        window.open(url, '_blank', 'noopener,noreferrer');
                        setTimeout(() => URL.revokeObjectURL(url), 60_000);
                      } catch {
                        window.open(attachment.dataUrl, '_blank');
                      }
                    }}
                  >
                    <img
                      src={attachment.dataUrl}
                      alt={attachment.name ?? 'Attachment'}
                      className="size-full object-cover"
                    />
                  </button>
                ))}
              </div>
            ) : null}
            {message.content ? (
              <p className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-[1.55]">
                {message.content}
              </p>
            ) : null}
          </div>
          <div className="mt-1 flex min-w-0 items-center justify-between gap-2">
            {sentAt ? (
              <time
                dateTime={message.createdAt}
                className="type-caption text-muted-foreground/55 tabular-nums"
              >
                {sentAt}
              </time>
            ) : null}
            <div className="flex min-w-0 items-center">
              <MessageActions
                content={message.content}
                align="start"
                showEdit={canEdit}
                onEdit={startEdit}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
