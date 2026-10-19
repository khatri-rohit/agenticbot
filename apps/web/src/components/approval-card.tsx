'use client';

import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import type { ApprovalDecision } from '@org/agent-models';
import { Button } from '@/components/ui/button';
import type { PendingApproval } from '../features/agent/store/chat-store';

function toolLabel(toolName: string): string {
  if (toolName === 'edit_file') return 'Edit file';
  if (toolName === 'run_terminal') return 'Run command';
  if (toolName === 'ask_user') return 'Question';
  return toolName;
}

/**
 * Sticky pause card: Allow / Deny / Allow for this run, or option buttons
 * for ask_user. Lives next to the composer so the decision is in reach.
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
  const isChoice = approval.toolName === 'ask_user' && options.length > 0;

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
      aria-label="Waiting for approval"
      aria-live="polite"
    >
      <div className="flex items-start gap-2 px-3 py-2">
        <ShieldAlert
          className="mt-0.5 size-3.5 shrink-0 text-foreground/80"
          strokeWidth={1.75}
        />
        <div className="min-w-0 flex-1">
          <p className="type-ui text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            {toolLabel(approval.toolName)}
          </p>
          <p className="type-ui mt-0.5 text-[13px] leading-relaxed text-foreground/90">
            {approval.summary}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 border-t border-border/60 px-3 py-2">
        {isChoice
          ? options.map((option) => (
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
            ))
          : null}
        {/*
          IMPORTANT: Allow/Deny exec-approval buttons. Temporarily commented
          so file and command tools run without a pause, as they did before
          this card. Do not delete this block — it must stay in the tree,
          commented, until the Allow/Deny system is restored.

          {isChoice ? null : (
            <>
              <Button
                type="button"
                size="sm"
                disabled={Boolean(busy)}
                onClick={() => void act('approved')}
              >
                {busy === 'approved' ? 'Allowing…' : 'Allow'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={Boolean(busy)}
                onClick={() => void act('approved_for_run')}
              >
                {busy === 'approved_for_run'
                  ? 'Allowing…'
                  : 'Allow for this run'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={Boolean(busy)}
                onClick={() => void act('denied')}
              >
                {busy === 'denied' ? 'Denying…' : 'Deny'}
              </Button>
            </>
          )}
        */}
      </div>
    </section>
  );
}
