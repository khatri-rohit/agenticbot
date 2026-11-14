'use client';

import type { RunPosture } from '@agent/agent-models';

import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export const POSTURE_LABEL: Record<RunPosture, string> = {
  ask: 'Ask',
  plan: 'Plan',
  agent: 'Agent',
};

const ORDER: RunPosture[] = ['ask', 'plan', 'agent'];

/** Ctrl+, cycles Ask → Plan → Agent → Ask. */
export function nextPosture(current: RunPosture): RunPosture {
  return ORDER[(ORDER.indexOf(current) + 1) % ORDER.length] ?? 'agent';
}

/** Workspace Ask / Plan / Agent switch for the next send. Ask and Plan are read-only. */
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
          {ORDER.map((id) => {
            const selected = posture === id;
            return (
              <Button
                key={id}
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
                onClick={() => onChange(id)}
              >
                {POSTURE_LABEL[id]}
              </Button>
            );
          })}
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <span className="flex items-center gap-1.5">
          Ask and Plan are read-only; Plan ends with a plan to approve
          <Kbd>Ctrl</Kbd>
          <Kbd>,</Kbd>
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
