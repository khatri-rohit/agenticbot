'use client';

import { useEffect, useState } from 'react';
import { MessageCircleQuestion } from 'lucide-react';
import type { ApprovalDecision } from '@desk/agent-models';
import { Button } from '@/components/ui/button';
import type { PendingApproval } from '../features/agent/store/chat-store';

/**
 * Sticky pause card for ask_user option buttons. Lives next to the composer.
 */
export function ApprovalCard({
  approval,
  onResolve,
}: {
  approval: PendingApproval | null;
  onResolve: (
    approvalId: string,
    decision: ApprovalDecision,
    optionId?: string,
  ) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const approvalId = approval?.approvalId ?? '';

  useEffect(() => {
    setBusy(null);
  }, [approvalId]);

  if (!approval) return null;

  const options = approval.options ?? [];
  if (approval.toolName !== 'ask_user' || options.length === 0) {
    return null;
  }

  const act = async (decision: ApprovalDecision, optionId?: string) => {
    if (busy) return;
    setBusy(optionId ?? decision);
    try {
      await onResolve(approval.approvalId, decision, optionId);
    } catch {
      setBusy(null);
    }
  };

  return (
    <section
      className="mb-2 min-w-0 overflow-hidden rounded-xl border border-border/60 bg-muted/25"
      aria-label="Waiting for your answer"
      aria-live="polite"
    >
      <div className="flex items-start gap-2 px-3 py-2">
        <MessageCircleQuestion
          className="mt-0.5 size-3.5 shrink-0 text-foreground/80"
          strokeWidth={1.75}
        />
        <div className="min-w-0 flex-1">
          <p className="type-ui text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            Question
          </p>
          <p className="type-ui mt-0.5 text-[13px] leading-relaxed text-foreground/90">
            {approval.summary}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 border-t border-border/60 px-3 py-2">
        {options.map((option) => (
          <Button
            key={option.id}
            type="button"
            size="sm"
            variant="outline"
            disabled={Boolean(busy)}
            onClick={() => void act('approved', option.id)}
          >
            {busy === option.id ? 'Sending…' : option.label}
          </Button>
        ))}
      </div>
    </section>
  );
}
