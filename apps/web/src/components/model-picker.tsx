'use client';

import { Check, ChevronDown, ImageIcon } from 'lucide-react';
import {
  OLLAMA_CLOUD_MODELS,
  getOllamaCloudModelLabel,
  resolveOllamaCloudModel,
  type OllamaCloudModel,
} from '@/lib/ollama-cloud-models';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

const FAMILIES: OllamaCloudModel['family'][] = ['GLM', 'Qwen', 'Gemma', 'Kimi'];

export function ModelPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
}) {
  const modelId = resolveOllamaCloudModel(value);
  const label = getOllamaCloudModelLabel(modelId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
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
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-80 max-h-[min(24rem,70vh)] overflow-y-auto"
      >
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Ollama Cloud
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {FAMILIES.map((family) => {
          const models = OLLAMA_CLOUD_MODELS.filter((m) => m.family === family);
          if (models.length === 0) return null;
          return (
            <div key={family} className="py-0.5">
              <p className="px-2 py-1 text-[10px] font-medium tracking-wide text-muted-foreground/80 uppercase">
                {family}
              </p>
              {models.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={cn(
                    'flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent',
                    m.id === modelId && 'bg-accent/60',
                  )}
                  onClick={() => onChange(m.id)}
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
                  {m.vision ? (
                    <ImageIcon
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-label="Supports image input"
                    />
                  ) : (
                    <span className="size-3.5 shrink-0" aria-hidden />
                  )}
                </button>
              ))}
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
