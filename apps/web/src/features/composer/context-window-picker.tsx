'use client';

import { ChevronDown, Gauge } from 'lucide-react';
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  type ContextWindowMode,
} from '@agent/agent-models';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

function sizeLabel(tokens: number): string {
  return tokens >= 1_000_000
    ? `${Math.round(tokens / 100_000) / 10}M`
    : `${Math.round(tokens / 1_000)}K`;
}

/**
 * 200K (default) vs the model's full window. Hidden when the model is not
 * larger than 200K, since both options would be the same number.
 */
export function ContextWindowPicker({
  modelMax,
  value,
  onChange,
  disabled,
}: {
  modelMax: number | null | undefined;
  value: ContextWindowMode | undefined;
  onChange: (mode: ContextWindowMode) => void;
  disabled?: boolean;
}) {
  if (!modelMax || modelMax <= DEFAULT_CONTEXT_WINDOW_TOKENS) return null;
  const selected = value ?? 'default';
  const current =
    selected === 'model' ? sizeLabel(modelMax) : sizeLabel(DEFAULT_CONTEXT_WINDOW_TOKENS);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="h-7 gap-1 px-2 text-xs font-normal text-muted-foreground hover:text-foreground"
          aria-label={`Context window: ${current}`}
        >
          <Gauge className="size-3.5 shrink-0 opacity-80" aria-hidden />
          <span>{current}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Context window
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={selected}
          onValueChange={(mode) => onChange(mode === 'model' ? 'model' : 'default')}
        >
          <DropdownMenuRadioItem value="default" className="text-xs">
            {sizeLabel(DEFAULT_CONTEXT_WINDOW_TOKENS)} (default, cheaper)
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="model" className="text-xs">
            Model max ({sizeLabel(modelMax)})
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
