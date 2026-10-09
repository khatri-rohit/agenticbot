'use client';

import { Brain, ChevronDown } from 'lucide-react';
import type { OllamaThinkingConfig, ThinkingValue } from '@org/agent-models';
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

function thinkingKey(value: ThinkingValue): string {
  if (value === false) return 'off';
  if (value === true) return 'on';
  return String(value);
}

function thinkingFromKey(
  key: string,
  values: ThinkingValue[],
): ThinkingValue {
  if (key === 'off') return false;
  if (key === 'on') return true;
  const match = values.find((v) => typeof v === 'string' && v === key);
  return match ?? key;
}

function thinkingLabel(value: ThinkingValue): string {
  if (value === false) return 'Off';
  if (value === true) return 'On';
  const text = String(value);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function ThinkingPicker({
  thinking,
  value,
  onChange,
  disabled,
}: {
  thinking: OllamaThinkingConfig;
  value: ThinkingValue | undefined;
  onChange: (value: ThinkingValue) => void;
  disabled?: boolean;
}) {
  if (!thinking.supported || thinking.values.length === 0) return null;

  const selected = value ?? thinking.default ?? thinking.values[0];
  const selectedKey = thinkingKey(selected);
  const isBoolean = thinking.mode === 'boolean';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="h-7 max-w-34 gap-1 px-2 text-xs font-normal text-muted-foreground hover:text-foreground"
          aria-label={`Thinking: ${thinkingLabel(selected)}`}
        >
          <Brain className="size-3.5 shrink-0 opacity-80" aria-hidden />
          <span className="truncate">{thinkingLabel(selected)}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-40">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {isBoolean ? 'Thinking' : 'Effort'}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={selectedKey}
          onValueChange={(key) =>
            onChange(thinkingFromKey(key, thinking.values))
          }
        >
          {thinking.values.map((option) => {
            const key = thinkingKey(option);
            return (
              <DropdownMenuRadioItem key={key} value={key}>
                {thinkingLabel(option)}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
