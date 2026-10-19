'use client';

import { useEffect, useState } from 'react';
import { ListChecks } from 'lucide-react';
import { MAX_CHOICE_TEXT_CHARS } from '@org/agent-models';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { PendingChoice } from '../features/agent/store/chat-store';

/**
 * Mid-turn direction: checkboxes + extra text, then Continue or Skip.
 * Skip ends the run; it does not pick a default path.
 */
export function ChoiceCard({
  choice,
  onResolve,
}: {
  choice: PendingChoice | null;
  onResolve: (
    choiceId: string,
    body: { skipped: true } | { optionIds: string[]; text?: string },
  ) => Promise<void>;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'skip' | 'continue' | null>(null);
  const choiceId = choice?.choiceId ?? '';

  useEffect(() => {
    setSelected(new Set());
    setText('');
    setBusy(null);
  }, [choiceId]);

  if (!choice) return null;

  const extra = text.trim();
  const canContinue = selected.size > 0 || extra.length > 0;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const act = async (
    body: { skipped: true } | { optionIds: string[]; text?: string },
    kind: 'skip' | 'continue',
  ) => {
    if (busy) return;
    setBusy(kind);
    try {
      await onResolve(choice.choiceId, body);
    } catch {
      setBusy(null);
    }
  };

  return (
    <section
      className="mb-2 min-w-0 overflow-hidden rounded-xl border border-border/60 bg-muted/25"
      aria-label="Waiting for a choice"
      aria-live="polite"
    >
      <div className="flex items-start gap-2 px-3 py-2">
        <ListChecks
          className="mt-0.5 size-3.5 shrink-0 text-foreground/80"
          strokeWidth={1.75}
        />
        <p className="type-ui min-w-0 flex-1 text-[13px] leading-relaxed text-foreground/90">
          {choice.question}
        </p>
      </div>
      <fieldset
        className="flex flex-col gap-1.5 border-t border-border/60 px-3 py-2"
        disabled={Boolean(busy)}
      >
        <legend className="sr-only">Options</legend>
        {choice.options.map((option) => {
          const checked = selected.has(option.id);
          return (
            <label
              key={option.id}
              className="flex cursor-pointer items-start gap-2 rounded-lg px-1 py-0.5 text-[13px] leading-relaxed text-foreground/90"
            >
              <input
                type="checkbox"
                className="mt-0.5 size-3.5 shrink-0 rounded-sm border-border accent-primary"
                checked={checked}
                onChange={() => toggle(option.id)}
              />
              <span>{option.label}</span>
            </label>
          );
        })}
        <Textarea
          value={text}
          maxLength={MAX_CHOICE_TEXT_CHARS}
          placeholder="Anything else? (optional)"
          rows={2}
          className="mt-1 min-h-12 text-[13px]"
          onChange={(event) => setText(event.target.value)}
        />
      </fieldset>
      <div className="flex flex-wrap gap-1.5 border-t border-border/60 px-3 py-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={Boolean(busy)}
          onClick={() => void act({ skipped: true }, 'skip')}
        >
          {busy === 'skip' ? 'Skipping…' : 'Skip'}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={Boolean(busy) || !canContinue}
          onClick={() =>
            void act(
              {
                optionIds: [...selected],
                ...(extra ? { text: extra } : {}),
              },
              'continue',
            )
          }
        >
          {busy === 'continue' ? 'Continuing…' : 'Continue'}
        </Button>
      </div>
    </section>
  );
}
