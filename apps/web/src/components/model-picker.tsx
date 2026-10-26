'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { Brain, Check, ChevronDown, ImageIcon, Search } from 'lucide-react';
import {
  CLOUD_OLLAMA_MODELS,
  getOllamaModelLabel,
  resolveOllamaModel,
  type OllamaModel,
} from '@/lib/ollama-models';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';

function matchesQuery(m: OllamaModel, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    m.label.toLowerCase().includes(needle) ||
    m.family.toLowerCase().includes(needle) ||
    m.id.toLowerCase().includes(needle) ||
    (m.hint?.toLowerCase().includes(needle) ?? false)
  );
}

export function ModelPicker({
  value,
  onChange,
  disabled,
  models = CLOUD_OLLAMA_MODELS,
  local = false,
  loading = false,
  emptyMessage,
}: {
  value: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
  /** Override catalog (e.g. discovered local installs). */
  models?: OllamaModel[];
  local?: boolean;
  loading?: boolean;
  emptyMessage?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const modelId = local ? value.trim() : resolveOllamaModel(value);
  const label = local
    ? modelId || 'Select local model'
    : getOllamaModelLabel(modelId);

  const filteredModels = useMemo(
    () => models.filter((m) => matchesQuery(m, query)),
    [models, query],
  );

  // Keep activeIndex in bounds when the filter changes.
  const clampedIndex = Math.min(activeIndex, Math.max(0, filteredModels.length - 1));

  const scrollActiveIntoView = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[clampedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [clampedIndex]);

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (filteredModels.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filteredModels.length - 1));
      requestAnimationFrame(scrollActiveIntoView);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
      requestAnimationFrame(scrollActiveIntoView);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const selected = filteredModels[clampedIndex];
      if (selected) {
        onChange(selected.id);
        setOpen(false);
        setQuery('');
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      setQuery('');
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="h-7 max-w-48 gap-1 rounded-full bg-muted/45 px-2.5 text-xs font-normal text-muted-foreground ring-1 ring-border/35 hover:bg-muted/70 hover:text-foreground"
          aria-label={`Model: ${label}`}
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-70" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={6}
        className="flex max-h-[min(24rem,70vh)] w-80 flex-col overflow-hidden p-0 bg-card shadow-lg"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border/40 px-2.5 py-2">
          <Search
            className="size-3.5 shrink-0 text-muted-foreground/70"
            aria-hidden
          />
          <input
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search models…"
            className="h-5 w-full bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/70"
            aria-label="Search models"
            aria-activedescendant={
              filteredModels.length > 0
                ? `model-option-${filteredModels[clampedIndex]?.id}`
                : undefined
            }
            role="combobox"
            aria-expanded={open}
            aria-controls="model-list"
          />
        </div>
        <div
          ref={listRef}
          id="model-list"
          role="listbox"
          className="min-h-0 flex-1 overflow-y-auto py-0.5"
        >
          {loading ? (
            <p className="px-2.5 py-4 text-center text-xs text-muted-foreground">
              Loading local models…
            </p>
          ) : filteredModels.length === 0 ? (
            <p className="px-2.5 py-4 text-center text-xs text-muted-foreground">
              {emptyMessage ?? 'No models found'}
            </p>
          ) : (
            filteredModels.map((m, index) => (
              <button
                key={m.id}
                id={`model-option-${m.id}`}
                role="option"
                aria-selected={m.id === modelId}
                type="button"
                className={cn(
                  'flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent',
                  m.id === modelId && 'bg-accent/60',
                  index === clampedIndex &&
                    'bg-accent ring-1 ring-inset ring-accent-foreground/20',
                )}
                onClick={() => {
                  onChange(m.id);
                  setOpen(false);
                  setQuery('');
                }}
              >
                <span className="flex min-w-0 flex-1 items-start gap-2">
                  <Check
                    className={cn(
                      'mt-0.5 size-3.5 shrink-0',
                      m.id === modelId ? 'opacity-100' : 'opacity-0',
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium leading-tight">
                      {m.label}
                    </span>
                    {m.hint ? (
                      <span className="type-caption block truncate text-muted-foreground">
                        {m.hint}
                      </span>
                    ) : null}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {m.contextLength != null ? (
                    <span
                      className="type-caption font-medium tabular-nums text-muted-foreground"
                      title={`${m.contextLength.toLocaleString()} token context`}
                    >
                      {m.contextLength >= 1_000_000
                        ? `${m.contextLength / 1_000_000}M`
                        : `${m.contextLength / 1_000}K`}
                    </span>
                  ) : null}
                  {m.thinking ? (
                    <Brain
                      className="size-3.5 text-muted-foreground"
                      aria-label="Supports thinking"
                    />
                  ) : null}
                  {m.vision ? (
                    <ImageIcon
                      className="size-3.5 text-muted-foreground"
                      aria-label="Supports image input"
                    />
                  ) : null}
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
