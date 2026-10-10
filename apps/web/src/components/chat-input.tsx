'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { ArrowUp, Loader2, Mic, Pencil, Plus, Square } from 'lucide-react';
import type { ComposerOptions } from '@/features/agent/api/agent-client';
import type { QueuedMessage } from '@/features/agent/hooks/use-agent-run';
import { useOllamaModelConfig } from '@/features/agent/hooks/use-ollama-model-config';
import { useVoiceInput } from '@/features/agent/hooks/use-voice-input';
import { appendComposerText } from '@/features/agent/lib/voice-transcript';
import { estimateTokens } from '@/lib/estimate-tokens';
import { ModelPicker } from '@/components/model-picker';
import { ThinkingPicker } from '@/components/thinking-picker';
import { ContextUsage } from '@/components/context-usage';
import { VoiceModePill } from '@/components/voice-mode-pill';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
} from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

function composerPlaceholder(opts: {
  voiceActive: boolean;
  voiceTranscribing: boolean;
  isHero: boolean;
  isRunning: boolean;
}): string {
  if (opts.voiceActive) return 'Listening… speech appends here';
  if (opts.voiceTranscribing) return 'Transcribing…';
  if (opts.isHero) return 'Ask a research question…';
  if (opts.isRunning) return 'Send follow-up…';
  return 'Message';
}

function sendButtonLabel(opts: {
  showStop: boolean;
  voiceActive: boolean;
  voiceTranscribing: boolean;
}): string {
  if (opts.showStop) return 'Stop generating';
  if (opts.voiceActive) return 'Stop voice mode before sending';
  if (opts.voiceTranscribing) return 'Wait for transcription before sending';
  return 'Send message';
}

export function ChatInput({
  onSend,
  isRunning,
  queuedMessage,
  onSendQueuedNow,
  onEditQueued,
  composerOptions,
  onComposerOptionsChange,
  onStop,
  variant = 'dock',
  contextMessages = [],
  streamingContent,
}: {
  onSend: (content: string, options: ComposerOptions) => void;
  isRunning: boolean;
  queuedMessage: QueuedMessage | null;
  onSendQueuedNow: () => void;
  onEditQueued: () => string | null;
  composerOptions: ComposerOptions;
  onComposerOptionsChange: (options: ComposerOptions) => void;
  /** Stops the active agent run; queue is preserved and runs after stop completes. */
  onStop?: () => void;
  variant?: 'dock' | 'hero';
  contextMessages?: Array<{ content?: string | null; toolCalls?: unknown }>;
  streamingContent?: string | null;
}) {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerOptionsRef = useRef(composerOptions);
  const onComposerOptionsChangeRef = useRef(onComposerOptionsChange);
  composerOptionsRef.current = composerOptions;
  onComposerOptionsChangeRef.current = onComposerOptionsChange;

  const voice = useVoiceInput({
    onTranscript: (text) => {
      setInput((prev) => appendComposerText(prev, text));
    },
  });
  const voiceLocked = voice.enabled && (voice.active || voice.transcribing);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, variant === 'hero' ? 200 : 160)}px`;
  }, [input, variant]);

  const handleSend = useCallback(() => {
    if (voiceLocked || !input.trim()) return;
    const content = input.trim();
    setInput('');
    onSend(content, composerOptions);
  }, [voiceLocked, input, onSend, composerOptions]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (voiceLocked) {
        e.preventDefault();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [voiceLocked, handleSend],
  );

  const handleEditQueued = useCallback(() => {
    const text = onEditQueued();
    if (text) setInput(text);
    textareaRef.current?.focus();
  }, [onEditQueued]);

  const modelConfig = useOllamaModelConfig(composerOptions.model);

  // When model config loads, pick a valid thinking value for that model.
  useEffect(() => {
    if (!modelConfig) return;
    const options = composerOptionsRef.current;
    const onChange = onComposerOptionsChangeRef.current;

    if (!modelConfig.thinking.supported) {
      if (options.thinking !== undefined) {
        onChange({ ...options, thinking: undefined });
      }
      return;
    }

    const allowed = modelConfig.thinking.values;
    if (
      options.thinking !== undefined &&
      allowed.some((v) => Object.is(v, options.thinking))
    ) {
      return;
    }
    onChange({
      ...options,
      thinking: modelConfig.thinking.default ?? allowed[0],
    });
  }, [modelConfig]);

  const usedTokens = estimateTokens(contextMessages, [
    input,
    streamingContent,
    queuedMessage?.content,
  ]);

  const isHero = variant === 'hero';
  const hasText = Boolean(input.trim());
  const showStopButton = isRunning && !hasText && Boolean(onStop);

  const handlePrimaryAction = useCallback(() => {
    if (showStopButton) {
      onStop?.();
      return;
    }
    if (voiceLocked) return;
    handleSend();
  }, [showStopButton, onStop, voiceLocked, handleSend]);

  return (
    <div
      className={cn(
        'shrink-0',
        isHero
          ? 'w-full px-0 py-0'
          : 'border-t border-border/25 bg-background/85 px-4 py-3 backdrop-blur-sm sm:px-6',
      )}
    >
      <div
        className={cn(
          'mx-auto w-full space-y-2',
          isHero ? 'max-w-none' : 'max-w-3xl',
        )}
      >
        {queuedMessage && (
          <Card
            size="sm"
            className="ring-border/60"
            role="status"
            aria-live="polite"
          >
            <CardHeader className="border-b border-border/40 pb-2">
              <Badge variant="secondary" className="font-normal">
                1 queued
              </Badge>
              <CardAction className="flex gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs"
                  onClick={handleEditQueued}
                >
                  <Pencil className="size-3" aria-hidden />
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => void onSendQueuedNow()}
                >
                  Send immediately
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              <p className="line-clamp-2 text-sm text-muted-foreground">
                {queuedMessage.content}
              </p>
            </CardContent>
          </Card>
        )}

        <Card
          className={cn(
            'gap-0 border border-border/50 bg-card py-0 shadow-none ring-0 focus-within:border-border/70',
            isHero && 'rounded-xl',
          )}
        >
          <CardContent className="p-1.5 sm:p-2">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                if (voiceLocked) return;
                setInput(e.target.value);
              }}
              onKeyDown={handleKeyDown}
              readOnly={voiceLocked}
              aria-readonly={voiceLocked}
              placeholder={composerPlaceholder({
                voiceActive: voice.active,
                voiceTranscribing: voice.transcribing,
                isHero,
                isRunning,
              })}
              rows={1}
              className={cn(
                'type-composer min-h-10 w-full resize-none rounded-md border-0 bg-transparent px-2 py-2.5 shadow-none placeholder:text-muted-foreground/70 focus-visible:ring-0',
                isHero && 'min-h-11',
                voiceLocked && 'caret-transparent',
              )}
            />
            <div className="flex items-center justify-between gap-2 border-t border-border/30 px-0.5 pt-1">
              <div className="flex min-w-0 flex-1 items-center gap-0.5">
                {voice.enabled && (voice.active || voice.transcribing) ? (
                  <VoiceModePill level={voice.level} className="mr-0.5" />
                ) : null}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 rounded-md"
                      aria-label="Composer options"
                    >
                      <Plus className="size-4" strokeWidth={2.25} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-52">
                    <DropdownMenuLabel>Composer</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuCheckboxItem
                      checked={composerOptions.streaming}
                      onCheckedChange={(checked) =>
                        onComposerOptionsChange({
                          ...composerOptions,
                          streaming: checked === true,
                        })
                      }
                    >
                      Stream response
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuCheckboxItem
                      checked={composerOptions.webSearch}
                      onCheckedChange={(checked) =>
                        onComposerOptionsChange({
                          ...composerOptions,
                          webSearch: checked === true,
                        })
                      }
                    >
                      Web search tool
                    </DropdownMenuCheckboxItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <ModelPicker
                  value={composerOptions.model}
                  onChange={(model) =>
                    onComposerOptionsChange({ ...composerOptions, model })
                  }
                  disabled={isRunning}
                />
                {modelConfig?.thinking.supported ? (
                  <ThinkingPicker
                    thinking={modelConfig.thinking}
                    value={composerOptions.thinking}
                    onChange={(thinking) =>
                      onComposerOptionsChange({ ...composerOptions, thinking })
                    }
                    disabled={isRunning}
                  />
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <ContextUsage
                  used={usedTokens}
                  limit={modelConfig?.contextLength ?? null}
                />
                {voice.enabled ? (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant={
                      voice.active || voice.transcribing ? 'secondary' : 'ghost'
                    }
                    onClick={() => voice.toggle()}
                    className={cn(
                      'shrink-0 rounded-md',
                      (voice.active || voice.transcribing) && 'text-foreground',
                    )}
                    aria-label={
                      voice.transcribing
                        ? 'Transcribing voice'
                        : voice.active
                          ? 'Stop voice mode'
                          : 'Start voice mode'
                    }
                    aria-pressed={voice.active}
                    aria-busy={voice.transcribing}
                    title={
                      voice.transcribing
                        ? 'Transcribing…'
                        : 'Voice mode (Alt+A)'
                    }
                  >
                    {voice.transcribing ? (
                      <Loader2
                        className="size-4 animate-spin"
                        strokeWidth={2.25}
                      />
                    ) : (
                      <Mic className="size-4" strokeWidth={2.25} />
                    )}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="icon-sm"
                  variant={showStopButton ? 'secondary' : 'default'}
                  onClick={handlePrimaryAction}
                  disabled={!showStopButton && (voiceLocked || !hasText)}
                  className={cn(
                    'shrink-0',
                    showStopButton ? 'rounded-md' : 'rounded-full',
                  )}
                  aria-label={sendButtonLabel({
                    showStop: showStopButton,
                    voiceActive: voice.active,
                    voiceTranscribing: voice.transcribing,
                  })}
                  title={
                    voiceLocked && !showStopButton
                      ? sendButtonLabel({
                          showStop: false,
                          voiceActive: voice.active,
                          voiceTranscribing: voice.transcribing,
                        })
                      : undefined
                  }
                >
                  {showStopButton ? (
                    <Square className="size-3.5 fill-current" strokeWidth={0} />
                  ) : (
                    <ArrowUp className="size-4" strokeWidth={2.25} />
                  )}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {voice.enabled && voice.error ? (
          <p className="type-caption text-destructive" role="alert">
            {voice.error}
          </p>
        ) : null}

        {isHero && (
          <p className="type-caption text-center text-muted-foreground/75">
            Threads are saved locally when you send your first message.
            {voice.enabled ? ' Voice: Alt+A.' : null}
          </p>
        )}
      </div>
    </div>
  );
}
