'use client';

import type { RunPosture } from '@agent/agent-models';

import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const OPTIONS = [
  { id: 'ask', label: 'Ask' },
  { id: 'agent', label: 'Agent' },
] as const;

/** Workspace Ask / Agent switch for the next send. */
export function PostureToggle({
  posture,
  onChange,
}: {
  posture: RunPosture;
  onChange: (posture: RunPosture) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="flex h-7 shrink-0 items-center rounded-md border border-border/60 p-0.5"
          role="group"
          aria-label="Workspace posture"
        >
          {OPTIONS.map((option) => {
            const selected = posture === option.id;
            return (
              <Button
                key={option.id}
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={selected}
                className={cn(
                  'h-6 px-2 text-xs font-normal',
                  selected
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => onChange(option.id)}
              >
                {option.label}
              </Button>
            );
          })}
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <span className="flex items-center gap-1.5">
          Posture — Ask / Agent
          <Kbd>Ctrl</Kbd>
          <Kbd>.</Kbd>
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
