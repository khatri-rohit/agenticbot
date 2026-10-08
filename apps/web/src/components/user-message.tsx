'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message } from '@org/agent-models';
import { MessageActions } from '@/components/message-actions';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export function UserMessage({
  message,
  registerAnchor,
  canEdit,
  hasResponseBelow,
  onEditSubmit,
}: {
  message: Message;
  registerAnchor: (id: string, el: HTMLDivElement | null) => void;
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

  const runSubmit = useCallback(async () => {
    const trimmed = draft.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await onEditSubmit(message.id, trimmed);
      setIsEditing(false);
      setConfirmClear(false);
    } finally {
      setSubmitting(false);
    }
  }, [draft, message.id, onEditSubmit, submitting]);

  const handleResend = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (hasResponseBelow) {
      setConfirmClear(true);
      return;
    }
    void runSubmit();
  }, [draft, hasResponseBelow, runSubmit]);

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
      ref={(el) => registerAnchor(message.id, el)}
      id={`conversation-anchor-${message.id}`}
      className="group/msg scroll-mt-8"
    >
      <div className="flex justify-end">
        <div className="max-w-[min(100%,32rem)] w-full">
          {isEditing ? (
            <div
              className="rounded-lg border border-border/50 bg-card/80 p-2"
              role="form"
              aria-label="Edit message"
            >
              <Textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={4}
                className="type-user h-24 min-h-24 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0"
              />
              {confirmClear ? (
                <div
                  className="mt-2 space-y-2 rounded-md border border-border/60 bg-muted/30 px-2.5 py-2"
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
                      disabled={submitting || !draft.trim()}
                      onClick={() => void runSubmit()}
                    >
                      {submitting ? 'Sending…' : 'Proceed'}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-1.5 flex flex-wrap justify-end gap-1.5">
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
                    disabled={submitting || !draft.trim()}
                    onClick={handleResend}
                  >
                    Resend
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <>
              <div
                className={cn(
                  'type-user rounded-lg border border-border/25 bg-secondary/90 px-3.5 py-2 text-foreground/95',
                )}
              >
                <p className="whitespace-pre-wrap">{message.content}</p>
              </div>
              <MessageActions
                content={message.content}
                align="end"
                showEdit={canEdit}
                onEdit={startEdit}
                className="opacity-0 transition-opacity group-hover/msg:opacity-100 group-focus-within/msg:opacity-100"
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
