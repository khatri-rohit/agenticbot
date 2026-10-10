'use client';

import { useMemo, useState } from 'react';
import { Brain, Check, ChevronDown, ImageIcon, Search } from 'lucide-react';
import {
  OLLAMA_MODELS,
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

type Group = {
  label: string;
  models: OllamaModel[];
};

function groupModels(models: OllamaModel[]): Group[] {
  const groups = new Map<string, OllamaModel[]>();

  for (const m of models) {
    const key = m.cloud ? `Cloud — ${m.family}` : `Local — ${m.family}`;
    const list = groups.get(key);
    if (list) list.push(m);
    else groups.set(key, [m]);
  }

  const order: string[] = [];
  for (const key of groups.keys()) {
    if (key.startsWith('Cloud')) order.push(key);
  }
  for (const key of groups.keys()) {
    if (key.startsWith('Local')) order.push(key);
  }

  return order.map((label) => ({ label, models: groups.get(label)! }));
}

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
}: {
  value: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const modelId = resolveOllamaModel(value);
  const label = getOllamaModelLabel(modelId);

  const groups = useMemo(() => {
    const filtered = OLLAMA_MODELS.filter((m) => matchesQuery(m, query));
    return groupModels(filtered);
  }, [query]);

  const handleSelect = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery('');
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="h-7 max-w-[11rem] gap-1 px-2 text-xs font-normal text-muted-foreground hover:text-foreground"
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
        className="flex max-h-[min(24rem,70vh)] w-80 flex-col overflow-hidden p-0"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border/40 px-2.5 py-2">
          <Search
            className="size-3.5 shrink-0 text-muted-foreground/70"
            aria-hidden
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search models…"
            className="h-5 w-full bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/70"
            aria-label="Search models"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-0.5">
          {groups.length === 0 ? (
            <p className="px-2.5 py-4 text-center text-xs text-muted-foreground">
              No models found
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.label} className="py-0.5">
                <p className="px-2 py-1 text-[10px] font-medium tracking-wide text-muted-foreground/80 uppercase">
                  {group.label}
                </p>
                {group.models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={cn(
                      'flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent',
                      m.id === modelId && 'bg-accent/60',
                    )}
                    onClick={() => handleSelect(m.id)}
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
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {m.hint}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
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
                ))}
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
