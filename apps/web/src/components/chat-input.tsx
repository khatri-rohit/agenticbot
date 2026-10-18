'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import {
  ArrowUp,
  ImagePlus,
  Loader2,
  Mic,
  Pencil,
  Plus,
  Square,
  X,
} from 'lucide-react';
import type { ContextReport, MessageAttachment } from '@org/agent-models';
import type { ComposerOptions } from '@/features/agent/api/agent-client';
import type { QueuedMessage } from '@/features/agent/hooks/use-agent-run';
import { useContextMeter } from '@/features/agent/hooks/use-context-meter';
import { useOllamaModelConfig } from '@/features/agent/hooks/use-ollama-model-config';
import { useVoiceInput } from '@/features/agent/hooks/use-voice-input';
import {
  MAX_IMAGE_ATTACHMENTS,
  fileToAttachment,
  filesFromDataTransfer,
  imageAttachErrorMessage,
} from '@/features/agent/lib/image-attachments';
import { toastError } from '@/hooks/use-toast';
import { modelSupportsVision, OLLAMA_MODELS } from '@/lib/ollama-models';
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
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

type ComposerDraft = {
  content: string;
  attachments: MessageAttachment[];
};

function draftStorageKey(scope: string): string {
  return `agenticbot:composerDraft:${scope}`;
}

function loadComposerDraft(scope: string): ComposerDraft | null {
  try {
    const raw = localStorage.getItem(draftStorageKey(scope));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      content?: unknown;
      attachments?: unknown;
    };
    const content = typeof parsed.content === 'string' ? parsed.content : '';
    const attachments = Array.isArray(parsed.attachments)
      ? parsed.attachments.filter(
          (a): a is MessageAttachment =>
            !!a &&
            typeof a === 'object' &&
            typeof (a as MessageAttachment).id === 'string' &&
            typeof (a as MessageAttachment).mimeType === 'string' &&
            typeof (a as MessageAttachment).dataUrl === 'string',
        )
      : [];
    if (!content.trim() && attachments.length === 0) return null;
    return { content, attachments };
  } catch {
    return null;
  }
}

function saveComposerDraft(scope: string, draft: ComposerDraft): void {
  if (!draft.content.trim() && draft.attachments.length === 0) {
    try {
      localStorage.removeItem(draftStorageKey(scope));
    } catch {
      /* storage blocked */
    }
    return;
  }
  try {
    localStorage.setItem(draftStorageKey(scope), JSON.stringify(draft));
  } catch {
    // Quota: keep text if images do not fit.
    if (draft.attachments.length > 0 && draft.content.trim()) {
      try {
        localStorage.setItem(
          draftStorageKey(scope),
          JSON.stringify({ content: draft.content, attachments: [] }),
        );
      } catch {
        /* storage blocked */
      }
    }
  }
}

function clearComposerDraft(scope: string): void {
  try {
    localStorage.removeItem(draftStorageKey(scope));
  } catch {
    /* storage blocked */
  }
}

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
  threadId,
  occupiedTokens,
  occupiedCoversStream,
  estimatedPromptTokens,
  contextReport,
  streamingContent,
  runModel,
  /** localStorage draft scope — thread id or home key; remount via `key` when it changes. */
  draftScope,
  hideWebSearch = false,
}: {
  onSend: (
    content: string,
    options: ComposerOptions,
    attachments?: MessageAttachment[],
  ) => void;
  isRunning: boolean;
  queuedMessage: QueuedMessage | null;
  onSendQueuedNow: () => void;
  onEditQueued: () => {
    content: string;
    attachments?: MessageAttachment[];
  } | null;
  composerOptions: ComposerOptions;
  onComposerOptionsChange: (options: ComposerOptions) => void;
  /** Stops the active agent run; queue is preserved and runs after stop completes. */
  onStop?: () => void;
  variant?: 'dock' | 'hero';
  threadId?: string;
  occupiedTokens?: number;
  occupiedCoversStream?: boolean;
  estimatedPromptTokens?: number;
  contextReport?: ContextReport;
  streamingContent?: string | null;
  runModel?: string;
  draftScope: string;
  hideWebSearch?: boolean;
}) {
  const [input, setInput] = useState(
    () => loadComposerDraft(draftScope)?.content ?? '',
  );
  const [pendingAttachments, setPendingAttachments] = useState<
    MessageAttachment[]
  >(() => loadComposerDraft(draftScope)?.attachments ?? []);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerOptionsRef = useRef(composerOptions);
  const onComposerOptionsChangeRef = useRef(onComposerOptionsChange);
  composerOptionsRef.current = composerOptions;
  onComposerOptionsChangeRef.current = onComposerOptionsChange;

  const voice = useVoiceInput({
    onTranscript: (text) => {
      const piece = text.trim();
      if (!piece) return;
      setInput((prev) => {
        const base = prev.trimEnd();
        return base ? `${base} ${piece}` : piece;
      });
    },
  });
  const voiceLocked = voice.enabled && (voice.active || voice.transcribing);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, variant === 'hero' ? 200 : 160)}px`;
  }, [input, variant]);

  // Persist draft per thread / home; cleared on send.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      saveComposerDraft(draftScope, {
        content: input,
        attachments: pendingAttachments,
      });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [draftScope, input, pendingAttachments]);

  const modelConfig = useOllamaModelConfig(composerOptions.model);
  const contextLimit =
    modelConfig?.contextLength ??
    OLLAMA_MODELS.find((m) => m.id === composerOptions.model)?.contextLength ??
    null;
  const visionOk = modelSupportsVision(
    composerOptions.model,
    modelConfig?.supportsVision,
  );
  const contextMeter = useContextMeter({
    threadId,
    draft: input,
    pendingAttachments,
    queuedContent: queuedMessage?.content,
    queuedAttachments: queuedMessage?.attachments,
    composerOptions,
    contextLimit,
    streamingContent,
    liveOccupiedTokens: occupiedTokens,
    occupiedCoversStream,
    liveEstimatedPromptTokens: estimatedPromptTokens,
    liveContextReport: contextReport,
    liveRunModel: runModel,
  });

  const addFiles = useCallback(
    async (files: File[]) => {
      if (voiceLocked || files.length === 0) return;
      let count = pendingAttachments.length;
      const next: MessageAttachment[] = [];
      for (const file of files) {
        if (count >= MAX_IMAGE_ATTACHMENTS) {
          toastError(
            imageAttachErrorMessage('too_many'),
            'Cannot attach image',
          );
          break;
        }
        const result = await fileToAttachment(file, count);
        if (!result.ok) {
          toastError(
            imageAttachErrorMessage(result.error),
            'Cannot attach image',
          );
          continue;
        }
        next.push(result.attachment);
        count += 1;
      }
      if (next.length > 0) {
        setPendingAttachments((prev) =>
          [...prev, ...next].slice(0, MAX_IMAGE_ATTACHMENTS),
        );
      }
    },
    [pendingAttachments.length, voiceLocked],
  );

  const removeAttachment = useCallback(
    (id: string) => {
      if (voiceLocked) return;
      setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
    },
    [voiceLocked],
  );

  const handleSend = useCallback(() => {
    const content = input.trim();
    if (!content && pendingAttachments.length === 0) return;

    if (pendingAttachments.length > 0 && !visionOk) {
      toastError(
        'This model does not support images. Pick a vision model.',
        'Vision not supported',
      );
      return;
    }

    // Enter/send while listening: drop the mic and ship what's already in the box.
    if (voice.active || voice.transcribing) {
      voice.stop();
    }

    const attachments =
      pendingAttachments.length > 0 ? pendingAttachments : undefined;
    setInput('');
    setPendingAttachments([]);
    clearComposerDraft(draftScope);
    onSend(
      content,
      hideWebSearch
        ? { ...composerOptions, webSearch: false }
        : composerOptions,
      attachments,
    );
  }, [
    input,
    pendingAttachments,
    visionOk,
    voice.active,
    voice.transcribing,
    voice.stop,
    hideWebSearch,
    onSend,
    composerOptions,
    draftScope,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
        return;
      }
      // Keep the field read-only while dictating; Enter above still sends.
      if (voiceLocked) {
        e.preventDefault();
      }
    },
    [voiceLocked, handleSend],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (voiceLocked) return;
      const files = filesFromDataTransfer(e.clipboardData);
      if (files.length === 0) return;
      e.preventDefault();
      void addFiles(files);
    },
    [voiceLocked, addFiles],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (voiceLocked) return;
      if (![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      setDragOver(true);
    },
    [voiceLocked],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      setDragOver(false);
      if (voiceLocked) return;
      e.preventDefault();
      const files = filesFromDataTransfer(e.dataTransfer);
      void addFiles(files);
    },
    [voiceLocked, addFiles],
  );

  const handleEditQueued = useCallback(() => {
    const queued = onEditQueued();
    if (!queued) return;
    setInput(queued.content);
    setPendingAttachments(queued.attachments ?? []);
    textareaRef.current?.focus();
  }, [onEditQueued]);

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

  const isHero = variant === 'hero';
  const hasText = Boolean(input.trim());
  const canSend = hasText || pendingAttachments.length > 0;
  const showStopButton =
    isRunning && !hasText && pendingAttachments.length === 0 && Boolean(onStop);

  const handlePrimaryAction = useCallback(() => {
    if (showStopButton) {
      onStop?.();
      return;
    }
    handleSend();
  }, [showStopButton, onStop, handleSend]);

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
            <CardContent className="space-y-2">
              {queuedMessage.attachments &&
              queuedMessage.attachments.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {queuedMessage.attachments.map((attachment) => (
                    <img
                      key={attachment.id}
                      src={attachment.dataUrl}
                      alt={attachment.name ?? 'Queued attachment'}
                      className="size-10 rounded-md object-cover ring-1 ring-border/50"
                    />
                  ))}
                </div>
              ) : null}
              {queuedMessage.content ? (
                <p className="line-clamp-2 text-sm text-muted-foreground">
                  {queuedMessage.content}
                </p>
              ) : queuedMessage.attachments?.length ? (
                <p className="text-sm text-muted-foreground">
                  {queuedMessage.attachments.length === 1
                    ? '1 image'
                    : `${queuedMessage.attachments.length} images`}
                </p>
              ) : null}
            </CardContent>
          </Card>
        )}

        <Card
          className={cn(
            'gap-0 border border-border/50 bg-card py-0 shadow-none ring-0 focus-within:border-border/70',
            isHero && 'rounded-xl',
            dragOver && 'border-primary/60 ring-2 ring-primary/20',
          )}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <CardContent className="p-1.5 sm:p-2">
            {/* Pending vision previews — above the textarea, clear before send. */}
            {pendingAttachments.length > 0 ? (
              <div className="mb-1.5 flex flex-wrap gap-2 px-1 pt-0.5">
                {pendingAttachments.map((attachment) => (
                  <div
                    key={attachment.id}
                    className="group relative size-16 overflow-hidden rounded-md ring-1 ring-border/50"
                  >
                    <img
                      src={attachment.dataUrl}
                      alt={attachment.name ?? 'Attachment'}
                      className="size-full object-cover"
                    />
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="secondary"
                      disabled={voiceLocked}
                      className="absolute top-0.5 right-0.5 size-5 rounded-full opacity-90 shadow-sm"
                      aria-label="Remove image"
                      onClick={() => removeAttachment(attachment.id)}
                    >
                      <X className="size-3" />
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                if (voiceLocked) return;
                setInput(e.target.value);
              }}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
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
                    <DropdownMenuItem
                      disabled={voiceLocked}
                      onSelect={() => {
                        fileInputRef.current?.click();
                      }}
                    >
                      <ImagePlus className="size-4" />
                      Attach image
                    </DropdownMenuItem>
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
                    {hideWebSearch ? null : (
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
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const list = e.target.files
                      ? Array.from(e.target.files)
                      : [];
                    e.target.value = '';
                    void addFiles(list);
                  }}
                />
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
                  used={contextMeter.used}
                  limit={contextMeter.limit}
                  source={contextMeter.source}
                  approximate={contextMeter.approximate}
                  layers={contextMeter.layers}
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
                  disabled={!showStopButton && !canSend}
                  className={cn(
                    'shrink-0',
                    showStopButton ? 'rounded-md' : 'rounded-full',
                  )}
                  aria-label={
                    showStopButton ? 'Stop generating' : 'Send message'
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
