'use client';

import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useLayoutEffect,
  useMemo,
} from 'react';
import {
  ArrowUp,
  BookMarked,
  ImagePlus,
  Loader2,
  Mic,
  Pencil,
  Plus,
  Square,
  X,
} from 'lucide-react';
import type {
  ContextReport,
  MessageAttachment,
  RunPosture,
} from '@agent/agent-models';
import {
  MAX_THREAD_MENTIONS,
  imageAttachments,
  isThreadMention,
  threadMentions,
} from '@agent/agent-models';
import {
  fetchCloudOllamaModels,
  fetchLocalOllamaModels,
  type ComposerOptions,
} from '@/features/agent/api/agent-client';
import type { QueuedMessage } from '@/features/agent/hooks/use-agent-run';
import { useContextMeter } from '@/features/agent/hooks/use-context-meter';
import { useOllamaBalance } from '@/features/agent/hooks/use-ollama-balance';
import { useOllamaModelConfig } from '@/features/agent/hooks/use-ollama-model-config';
import { useVoiceInput } from '@/features/agent/hooks/use-voice-input';
import {
  MAX_IMAGE_ATTACHMENTS,
  fileToAttachment,
  filesFromDataTransfer,
  imageAttachErrorMessage,
} from '@/features/agent/lib/image-attachments';
import { toastError } from '@/hooks/use-toast';
import {
  CLOUD_OLLAMA_MODELS,
  DEFAULT_OLLAMA_MODEL,
  listedModelToPickerModel,
  mergeCloudModels,
  modelSupportsVision,
  readStoredComposerModel,
  type OllamaModel,
} from '@/lib/ollama-models';
import { ModelPicker } from '@/components/model-picker';
import { WorkspacePicker } from '@/components/workspace-picker';
import { ThinkingPicker } from '@/components/thinking-picker';
import { ContextUsage } from '@/components/context-usage';
import { UsageMeter } from '@/components/usage-meter';
import { SkillsPanel } from '@/components/skills-panel';
import { registerComposerFocus } from '@/components/composer-focus';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
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
import { useThreads } from '@/features/agent/hooks/use-agent-run';
import { useAgentSpace } from '@/features/agent/store/space-store';
import {
  ThreadMentionChip,
  ThreadMentionPicker,
  mentionQueryAtCaret,
  rankMentionThreads,
  threadToMention,
} from '@/components/thread-mention-picker';
import {
  SkillSlashPicker,
  SkillHighlightMirror,
  completeSkillToken,
  filterSkillCatalog,
  skillQueryAtCaret,
  skillTokensInText,
} from '@/components/skill-slash-picker';
import {
  fetchSkillCatalogs,
  type SkillCatalogItem,
} from '@/features/agent/api/skills-client';

type ComposerDraft = {
  content: string;
  attachments: MessageAttachment[];
};

function isPersistedAttachment(value: unknown): value is MessageAttachment {
  if (!value || typeof value !== 'object') return false;
  const rec = value as MessageAttachment;
  if (isThreadMention(rec)) {
    return (
      typeof rec.id === 'string' &&
      typeof rec.threadId === 'string' &&
      typeof rec.title === 'string'
    );
  }
  return (
    typeof rec.id === 'string' &&
    typeof rec.mimeType === 'string' &&
    typeof rec.dataUrl === 'string'
  );
}

function draftStorageKey(scope: string): string {
  return `agent:composerDraft:${scope}`;
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
      ? parsed.attachments.filter(isPersistedAttachment)
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
}): string {
  if (opts.voiceActive) return 'Listening… speech appends here';
  if (opts.voiceTranscribing) return 'Transcribing…';
  if (opts.isHero) return 'Ask anything to start…';
  return 'Send a follow-up…';
}

const WAVE_BAR_COUNT = 5;

/** Compact waveform that fits inside the mic button while voice is active. */
function MicWaveform({ level }: { level: number }) {
  const clamped = Math.max(0, Math.min(1, level));
  return (
    <span className="flex h-4 items-end gap-0.5" aria-hidden>
      {Array.from({ length: WAVE_BAR_COUNT }, (_, i) => {
        const weight = 1 - Math.abs(i - (WAVE_BAR_COUNT - 1) / 2) * 0.28;
        const h = 22 + clamped * weight * 78;
        return (
          <span
            key={i}
            className="w-0.5 rounded-full bg-current transition-[height] duration-75 ease-out"
            style={{ height: `${h}%` }}
          />
        );
      })}
    </span>
  );
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
  showWorkspacePicker = false,
  showPostureChips = false,
  runPosture: _runPosture,
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
    skills?: ComposerOptions['skills'];
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
  showWorkspacePicker?: boolean;
  /** Workspace-only Ask | Agent. Home stays chip-less. */
  showPostureChips?: boolean;
  /** Host-applied posture for the in-flight run (from run.started). */
  runPosture?: RunPosture;
}) {
  const [input, setInput] = useState(
    () => loadComposerDraft(draftScope)?.content ?? '',
  );
  const [pendingAttachments, setPendingAttachments] = useState<
    MessageAttachment[]
  >(() => loadComposerDraft(draftScope)?.attachments ?? []);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionActive, setMentionActive] = useState(0);
  const [selectedMentionId, setSelectedMentionId] = useState<string | null>(
    null,
  );
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skillSlashOpen, setSkillSlashOpen] = useState(false);
  const [skillSlashQuery, setSkillSlashQuery] = useState('');
  const [skillSlashActive, setSkillSlashActive] = useState(0);
  const [skillCatalog, setSkillCatalog] = useState<SkillCatalogItem[]>([]);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const knownSkillNames = useMemo(
    () => new Set(skillCatalog.map((skill) => skill.name.toLowerCase())),
    [skillCatalog],
  );
  const catalog = useThreads() ?? [];
  const { workspaceRoot } = useAgentSpace();
  const mentionCandidates = rankMentionThreads(
    catalog,
    threadId,
    workspaceRoot,
  );
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerOptionsRef = useRef(composerOptions);
  const onComposerOptionsChangeRef = useRef(onComposerOptionsChange);
  composerOptionsRef.current = composerOptions;
  onComposerOptionsChangeRef.current = onComposerOptionsChange;

  const localMode = composerOptions.local === true;
  const [localModels, setLocalModels] = useState<OllamaModel[]>([]);
  const [localModelsLoading, setLocalModelsLoading] = useState(false);
  const [localModelsError, setLocalModelsError] = useState<string | null>(null);
  const [cloudModels, setCloudModels] = useState<OllamaModel[]>(CLOUD_OLLAMA_MODELS);

  // Discover cloud models from Ollama Cloud on mount; fall back to the
  // static catalog on error so cloud chat still works with known models.
  useEffect(() => {
    let cancelled = false;
    void fetchCloudOllamaModels()
      .then((res) => {
        if (cancelled) return;
        const merged = mergeCloudModels(
          res.models.map((m) => ({ id: m.id, family: m.family, size: m.size })),
        );
        if (merged.length > 0) setCloudModels(merged);
      })
      .catch((err) => {
        // Keep the static catalog — cloud chat still works with known models.
        console.warn('[chat-input] live cloud models fetch failed, using catalog fallback', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Discover installed models from the API host's Ollama when Local is on.
  useEffect(() => {
    if (!localMode) {
      setLocalModels([]);
      setLocalModelsError(null);
      setLocalModelsLoading(false);
      return;
    }

    let cancelled = false;
    setLocalModelsLoading(true);
    setLocalModelsError(null);
    void fetchLocalOllamaModels()
      .then((res) => {
        if (cancelled) return;
        const next = res.models.map(listedModelToPickerModel);
        setLocalModels(next);
        setLocalModelsLoading(false);

        const current = composerOptionsRef.current;
        const stillValid = next.some((m) => m.id === current.model);
        if (stillValid) return;
        const preferred = readStoredComposerModel(true);
        const pick =
          next.find((m) => m.id === preferred)?.id ?? next[0]?.id ?? '';
        if (pick !== current.model) {
          onComposerOptionsChangeRef.current({
            ...current,
            local: true,
            model: pick,
            thinking: undefined,
          });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setLocalModels([]);
        setLocalModelsLoading(false);
        setLocalModelsError(
          err instanceof Error
            ? err.message
            : 'Could not reach Ollama on the API host (127.0.0.1:11434). Start `ollama serve` there, or set OLLAMA_LOCAL_BASE_URL.',
        );
      });

    return () => {
      cancelled = true;
    };
  }, [localMode]);

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
  const voiceLockedRef = useRef(voiceLocked);
  voiceLockedRef.current = voiceLocked;

  // Register so ChatShell type-to-focus can route printable keys here.
  useEffect(() => {
    registerComposerFocus({
      focus: () => textareaRef.current?.focus(),
      insertText: (text) => {
        if (voiceLockedRef.current) return;
        setInput((prev) => prev + text);
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        // Place caret at end after React applies the new value.
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (!el) return;
          const end = el.value.length;
          el.setSelectionRange(end, end);
        });
      },
      isLocked: () => voiceLockedRef.current,
    });
    return () => registerComposerFocus(null);
  }, []);

  // Size the textarea to its content, before paint. The composer is always in
  // the two-row layout, so there is no expand decision to oscillate.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const maxHeight = variant === 'hero' ? 200 : 160;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, maxHeight)}px`;
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

  const modelConfig = useOllamaModelConfig(composerOptions.model, localMode);
  // Soft fallback until /context/estimate or live ContextReport supplies windowTokens.
  const contextLimit =
    modelConfig?.contextLength ??
    cloudModels.find((m) => m.id === composerOptions.model)
      ?.contextLength ??
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
    skillHints: { requested: skillTokensInText(input) },
  });

  const ollamaBalance = useOllamaBalance({ local: composerOptions.local });

  // Catalog must be ready before the user types so inline `/name` tokens
  // highlight immediately; not keyed on picker open.
  useEffect(() => {
    let cancelled = false;
    void fetchSkillCatalogs()
      .then((catalogs) => {
        if (cancelled) return;
        setSkillCatalog([...catalogs.global, ...catalogs.user]);
      })
      .catch(() => {
        if (!cancelled) setSkillCatalog([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const addFiles = useCallback(
    async (files: File[]) => {
      if (voiceLocked || files.length === 0) return;
      let count = imageAttachments(pendingAttachments).length;
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
        setPendingAttachments((prev) => {
          const mentions = threadMentions(prev);
          const images = [...imageAttachments(prev), ...next].slice(
            0,
            MAX_IMAGE_ATTACHMENTS,
          );
          return [...mentions, ...images];
        });
      }
    },
    [pendingAttachments.length, voiceLocked],
  );

  const removeAttachment = useCallback(
    (id: string) => {
      if (voiceLocked) return;
      setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
      setSelectedMentionId((current) => (current === id ? null : current));
    },
    [voiceLocked],
  );

  const localModelReady =
    !localMode ||
    (!localModelsLoading &&
      !localModelsError &&
      localModels.some((m) => m.id === composerOptions.model));

  const handleSend = useCallback(() => {
    const content = input.trim();
    if (!content && pendingAttachments.length === 0) return;

    if (localMode) {
      if (localModelsLoading) {
        toastError(
          'Wait until installed models finish loading from the API host.',
          'Discovering local models',
        );
        return;
      }
      if (
        localModelsError ||
        !localModels.some((m) => m.id === composerOptions.model)
      ) {
        toastError(
          localModelsError ??
            'Pick a model installed on the API host, or turn off Local Ollama.',
          'Local model not ready',
        );
        return;
      }
    }

    if (imageAttachments(pendingAttachments).length > 0 && !visionOk) {
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
    setMentionOpen(false);
    setSkillSlashOpen(false);
    setSelectedMentionId(null);
    const requested = skillTokensInText(content);
    clearComposerDraft(draftScope);
    onSend(
      content,
      {
        ...composerOptions,
        ...(requested.length > 0 ? { skills: { requested } } : {}),
      },
      attachments,
    );
  }, [
    input,
    pendingAttachments,
    localMode,
    localModelsLoading,
    localModelsError,
    localModels,
    visionOk,
    voice.active,
    voice.transcribing,
    voice.stop,
    onSend,
    composerOptions,
    draftScope,
  ]);

  const visibleMentions = useMemo(() => {
    const needle = mentionQuery.trim().toLowerCase();
    if (!needle) return mentionCandidates;
    return mentionCandidates.filter((thread) => {
      const title = thread.title.toLowerCase();
      const folder = thread.workspaceRoot
        ? thread.workspaceRoot.toLowerCase()
        : 'home';
      return title.includes(needle) || folder.includes(needle);
    });
  }, [mentionCandidates, mentionQuery]);

  const pickMention = useCallback(
    (threadIdToAdd: string) => {
      const thread = mentionCandidates.find(
        (item) => item.id === threadIdToAdd,
      );
      if (!thread) return;
      const existing = threadMentions(pendingAttachments);
      if (existing.some((item) => item.threadId === thread.id)) {
        setMentionOpen(false);
        return;
      }
      if (existing.length >= MAX_THREAD_MENTIONS) {
        toastError(
          `You can attach up to ${MAX_THREAD_MENTIONS} threads.`,
          'Thread limit',
        );
        return;
      }
      const mention = threadToMention(thread);
      const ta = textareaRef.current;
      const caret = ta?.selectionStart ?? input.length;
      const found = mentionQueryAtCaret(input, caret);
      const nextText = found
        ? `${input.slice(0, found.start)}${input.slice(caret)}`
        : input;
      setInput(nextText);
      setPendingAttachments((prev) => [...prev, mention]);
      setMentionOpen(false);
      setMentionQuery('');
      setSelectedMentionId(mention.id);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        const pos = found ? found.start : nextText.length;
        el.setSelectionRange(pos, pos);
      });
    },
    [input, mentionCandidates, pendingAttachments],
  );

  const visibleSkills = useMemo(
    () => filterSkillCatalog(skillCatalog, skillSlashQuery),
    [skillCatalog, skillSlashQuery],
  );

  const pickSkill = useCallback(
    (skill: SkillCatalogItem) => {
      const ta = textareaRef.current;
      const caret = ta?.selectionStart ?? input.length;
      const next = completeSkillToken(input, caret, skill.name);
      setInput(next.text);
      setSkillSlashOpen(false);
      setSkillSlashQuery('');
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(next.caret, next.caret);
      });
    },
    [input],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (mentionOpen && visibleMentions.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setMentionActive((index) =>
            Math.min(index + 1, visibleMentions.length - 1),
          );
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setMentionActive((index) => Math.max(index - 1, 0));
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const thread = visibleMentions[mentionActive];
          if (thread) pickMention(thread.id);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setMentionOpen(false);
          return;
        }
      }

      if (skillSlashOpen && visibleSkills.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSkillSlashActive((index) =>
            Math.min(index + 1, visibleSkills.length - 1),
          );
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSkillSlashActive((index) => Math.max(index - 1, 0));
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const skill = visibleSkills[skillSlashActive];
          if (skill) pickSkill(skill);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setSkillSlashOpen(false);
          return;
        }
      }

      // Picker is open but empty: still let Escape close it, but let other
      // keys (Enter, arrows) fall through to normal input handling.
      if (skillSlashOpen && e.key === 'Escape') {
        e.preventDefault();
        setSkillSlashOpen(false);
        return;
      }

      if (e.key === 'Backspace') {
        const caret = e.currentTarget.selectionStart ?? 0;
        const end = e.currentTarget.selectionEnd ?? 0;
        if (selectedMentionId) {
          e.preventDefault();
          setPendingAttachments((prev) =>
            prev.filter((item) => item.id !== selectedMentionId),
          );
          setSelectedMentionId(null);
          return;
        }
        if (caret === 0 && end === 0 && !input) {
          const mentions = threadMentions(pendingAttachments);
          const last = mentions.at(-1);
          if (last) {
            e.preventDefault();
            setPendingAttachments((prev) =>
              prev.filter((item) => item.id !== last.id),
            );
            return;
          }
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
        return;
      }
      if (voiceLocked) {
        e.preventDefault();
      }
    },
    [
      mentionOpen,
      visibleMentions,
      mentionActive,
      pickMention,
      skillSlashOpen,
      visibleSkills,
      skillSlashActive,
      pickSkill,
      selectedMentionId,
      input,
      pendingAttachments,
      voiceLocked,
      handleSend,
    ],
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
    // Skill tokens live in the content itself; nothing to reconstruct.
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
  const canSend = (hasText || pendingAttachments.length > 0) && localModelReady;
  const showStopButton =
    isRunning && !hasText && pendingAttachments.length === 0 && Boolean(onStop);

  const handlePrimaryAction = useCallback(() => {
    if (showStopButton) {
      onStop?.();
      return;
    }
    handleSend();
  }, [showStopButton, onStop, handleSend]);

  const attachMenu = (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0 rounded-full text-muted-foreground hover:text-foreground"
            aria-label="Composer options"
          >
            <Plus className="size-4" strokeWidth={2.25} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="w-52 bg-card shadow-lg">
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
          <DropdownMenuItem
            onSelect={() => {
              setSkillsOpen(true);
            }}
          >
            <BookMarked className="size-4" />
            Skills
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={localMode}
            onCheckedChange={(checked) => {
              const nextLocal = checked === true;
              if (nextLocal === localMode) return;
              const model = nextLocal
                ? readStoredComposerModel(true)
                : readStoredComposerModel(false) || DEFAULT_OLLAMA_MODEL;
              onComposerOptionsChange({
                ...composerOptions,
                local: nextLocal,
                model,
                thinking: undefined,
              });
            }}
          >
            Local Ollama
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
          const list = e.target.files ? Array.from(e.target.files) : [];
          e.target.value = '';
          void addFiles(list);
        }}
      />
    </>
  );

  const posture: RunPosture = composerOptions.posture ?? 'agent';
  // Chip is always editable: next/queued send uses the live selection.
  // Host run posture is shown separately via run.started.

  const postureChips = showPostureChips ? (
    <div
      className="flex h-7 shrink-0 items-center rounded-md border border-border/60 p-0.5"
      role="group"
      aria-label="Workspace posture"
    >
      {(
        [
          { id: 'ask', label: 'Ask' },
          { id: 'agent', label: 'Agent' },
        ] as const
      ).map((option) => {
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
            onClick={() =>
              onComposerOptionsChange({
                ...composerOptions,
                posture: option.id,
              })
            }
          >
            {option.label}
          </Button>
        );
      })}
    </div>
  ) : null;

  const modelControls = (
    <>
      {postureChips}
      <ModelPicker
        value={composerOptions.model}
        onChange={(model) =>
          onComposerOptionsChange({
            ...composerOptions,
            model,
            thinking: undefined,
          })
        }
        disabled={isRunning}
        local={localMode}
        models={localMode ? localModels : cloudModels}
        loading={localMode && localModelsLoading}
        emptyMessage={
          localMode
            ? (localModelsError ??
              'No models on the API host. Run `ollama pull <model>` where apps/api runs, then toggle Local again.')
            : undefined
        }
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
      <ContextUsage
        used={contextMeter.used}
        limit={contextMeter.limit}
        source={contextMeter.source}
        approximate={contextMeter.approximate}
        layers={contextMeter.layers}
        reserve={contextMeter.reserve}
        windowSource={contextMeter.windowSource}
      />
    </>
  );

  const actionControls = (
    <>
      <UsageMeter
        balance={ollamaBalance.balance}
        loading={ollamaBalance.loading}
      />
      {voice.enabled ? (
        <Button
          type="button"
          size="icon-sm"
          variant={voice.active || voice.transcribing ? 'secondary' : 'ghost'}
          onClick={() => voice.toggle()}
          aria-label={
            voice.transcribing
              ? 'Transcribing voice'
              : voice.active
                ? 'Stop voice mode'
                : 'Start voice mode'
          }
          aria-pressed={voice.active}
          aria-busy={voice.transcribing}
          title={voice.transcribing ? 'Transcribing…' : 'Voice mode'}
          className={cn(
            'shrink-0 rounded-full',
            (voice.active || voice.transcribing) && 'text-foreground',
            voice.active && 'w-auto px-2',
          )}
        >
          {voice.active ? (
            <MicWaveform level={voice.level} />
          ) : voice.transcribing ? (
            <Loader2 className="size-4 animate-spin" strokeWidth={2.25} />
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
        className="shrink-0 rounded-full"
        aria-label={showStopButton ? 'Stop generating' : 'Send message'}
      >
        {showStopButton ? (
          <Square className="size-3.5 fill-current" strokeWidth={0} />
        ) : (
          <ArrowUp className="size-4" strokeWidth={2.25} />
        )}
      </Button>
    </>
  );

  const composerTextarea = (
    <div className="relative min-w-0">
      <SkillHighlightMirror
        value={input}
        knownNames={knownSkillNames}
        mirrorRef={mirrorRef}
      />
      <Textarea
        ref={textareaRef}
        value={input}
        onChange={(e) => {
          if (voiceLocked) return;
          const value = e.target.value;
          setInput(value);
          const caret = e.target.selectionStart ?? value.length;
          const found = mentionQueryAtCaret(value, caret);
          if (found) {
            setMentionOpen(true);
            setMentionQuery(found.query);
            setMentionActive(0);
            setSkillSlashOpen(false);
            setSkillSlashQuery('');
            return;
          }
          setMentionOpen(false);
          setMentionQuery('');
          const skillFound = skillQueryAtCaret(value, caret);
          if (skillFound) {
            setSkillSlashOpen(true);
            setSkillSlashQuery(skillFound.query);
            setSkillSlashActive(0);
          } else {
            setSkillSlashOpen(false);
            setSkillSlashQuery('');
          }
        }}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        onScroll={(e) => {
          if (mirrorRef.current) {
            mirrorRef.current.scrollTop = e.currentTarget.scrollTop;
          }
        }}
        readOnly={voiceLocked}
        aria-readonly={voiceLocked}
        placeholder={composerPlaceholder({
          voiceActive: voice.active,
          voiceTranscribing: voice.transcribing,
          isHero,
        })}
        rows={1}
        className={cn(
          'type-composer max-h-40 min-h-9 w-full min-w-0 resize-none rounded-none border-0 bg-transparent px-1 py-2 text-transparent caret-foreground shadow-none placeholder:text-muted-foreground/50 focus-visible:ring-0',
          isHero && 'min-h-10',
          voiceLocked && 'caret-transparent',
        )}
      />
    </div>
  );

  return (
    <div
      className={cn(
        'min-w-0 shrink-0',
        isHero
          ? 'w-full px-0 py-0'
          : 'bg-background px-4 pb-4 pt-2 sm:px-6',
      )}
    >
      <div
        className={cn(
          'mx-auto w-full min-w-0 space-y-2',
          isHero ? 'max-w-none' : 'max-w-4xl',
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
                1 queued as {posture === 'ask' ? 'Ask' : 'Agent'}
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
                  {threadMentions(queuedMessage.attachments).map((mention) => (
                    <ThreadMentionChip key={mention.id} mention={mention} />
                  ))}
                  {imageAttachments(queuedMessage.attachments).map(
                    (attachment) => (
                      <img
                        key={attachment.id}
                        src={attachment.dataUrl}
                        alt={attachment.name ?? 'Queued attachment'}
                        className="size-10 rounded-md object-cover ring-1 ring-border/50"
                      />
                    ),
                  )}
                </div>
              ) : null}
              {queuedMessage.content ? (
                <p className="line-clamp-2 text-sm text-muted-foreground">
                  {queuedMessage.content}
                </p>
              ) : queuedMessage.attachments?.length ? (
                <p className="text-sm text-muted-foreground">
                  {threadMentions(queuedMessage.attachments).length > 0
                    ? `${threadMentions(queuedMessage.attachments).length} thread${threadMentions(queuedMessage.attachments).length === 1 ? '' : 's'}`
                    : imageAttachments(queuedMessage.attachments).length === 1
                      ? '1 image'
                      : `${imageAttachments(queuedMessage.attachments).length} images`}
                </p>
              ) : null}
            </CardContent>
          </Card>
        )}

        <div className="relative min-w-0">
          {/* Detached popover: anchored above the composer with a gap so
              opening/closing never shifts the composer layout. */}
          {skillSlashOpen && !mentionOpen ? (
            <SkillSlashPicker
              skills={skillCatalog}
              query={skillSlashQuery}
              activeIndex={skillSlashActive}
              onActiveIndexChange={setSkillSlashActive}
              selectedNames={
                new Set(skillTokensInText(input).map((n) => n.toLowerCase()))
              }
              onPick={pickSkill}
            />
          ) : null}
          <Card
            className={cn(
              'min-w-0 gap-0 overflow-hidden border-0 bg-card py-0 ring-1 ring-border/40 transition-[box-shadow,ring-color] focus-within:ring-border/65',
              'rounded-lg',
              dragOver && 'ring-2 ring-ring/25',
            )}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
          <CardContent className="relative min-w-0 px-2 py-1.5 sm:px-2.5 sm:py-2">
            {pendingAttachments.length > 0 ? (
              <div className="mb-1.5 flex flex-wrap items-center gap-2 px-1 pt-0.5">
                {threadMentions(pendingAttachments).map((mention) => (
                  <ThreadMentionChip
                    key={mention.id}
                    mention={mention}
                    selected={selectedMentionId === mention.id}
                    onSelect={() =>
                      setSelectedMentionId((current) =>
                        current === mention.id ? null : mention.id,
                      )
                    }
                    onRemove={
                      voiceLocked
                        ? undefined
                        : () => removeAttachment(mention.id)
                    }
                  />
                ))}
                {imageAttachments(pendingAttachments).map((attachment) => (
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

            {mentionOpen ? (
              <ThreadMentionPicker
                threads={mentionCandidates}
                query={mentionQuery}
                activeIndex={mentionActive}
                onActiveIndexChange={setMentionActive}
                selectedIds={
                  new Set(
                    threadMentions(pendingAttachments).map(
                      (mention) => mention.threadId,
                    ),
                  )
                }
                onPick={(thread) => pickMention(thread.id)}
              />
            ) : null}

            <div className="grid min-w-0 gap-1 [grid-template-areas:'text_text'_'left_right'] grid-cols-[minmax(0,1fr)_auto]">
              <div className="flex min-w-0 flex-wrap items-center gap-1 [grid-area:left]">
                {attachMenu}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 rounded-full text-muted-foreground hover:text-foreground"
                      aria-label="Skills"
                      aria-haspopup="dialog"
                      aria-expanded={skillsOpen}
                      onClick={() => setSkillsOpen(true)}
                    >
                      <BookMarked className="size-4" strokeWidth={2.25} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Skills</TooltipContent>
                </Tooltip>
                {showWorkspacePicker ? (
                  <WorkspacePicker disabled={isRunning} />
                ) : null}
                {modelControls}
              </div>
              <div className="min-w-0 [grid-area:text]">{composerTextarea}</div>
              <div className="flex shrink-0 items-center gap-0.5 self-end [grid-area:right]">
                {actionControls}
              </div>
            </div>
          </CardContent>
          </Card>
        </div>

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
      <SkillsPanel open={skillsOpen} onOpenChange={setSkillsOpen} />
    </div>
  );
}
