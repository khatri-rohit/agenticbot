'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import { useStickToBottom } from '../../hooks/use-stick-to-bottom';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  isResumableStop,
  type Message,
  type System1FallbackKind,
  type System1RunReport,
  type ThreadPlan,
} from '@agent/agent-models';
import type {
  ChatState,
  CompactionNotice,
  LimitNotice,
  PendingChoice,
  SubagentActivity,
  ToolActivity,
  AssistantSnippet,
} from './chat-store';
import { groupMessageTurns, type MessageTurn } from './group-message-turns';
import { buildTurnTimeline, summarizeTurnWork } from './turn-timeline';
import {
  formatDuration,
  formatMessageTime,
} from '../../lib/format-relative-time';
import { AgentMarkdown } from './agent-markdown';
import {
  ConversationRail,
  shouldShowConversationRail,
} from './conversation-rail';
import { MessageActions } from './message-actions';
import { CompactionCard } from './compaction-card';
import { SubagentCard } from './subagent-card';
import { ToolStepList } from './tool-call-panel';
import { PlanChip } from './thread-plan-card';
import { UserMessage } from './user-message';
import { isUserCancelled, stopReasonLabel } from './stop-reason';
import { toastError } from '@/hooks/use-toast';
import { cn } from 'cn';

export function MessageList({
  messages,
  chatState,
  isRunning,
  threadKind = 'home',
  onRetryLastResponse,
  onEditLastUserMessage,
  onContinue,
}: {
  messages: Message[] | undefined;
  chatState: ChatState;
  isRunning: boolean;
  threadKind?: 'home' | 'workspace';
  onRetryLastResponse: () => void | Promise<void>;
  /** Start the next run from the last run's handoff (budget/capacity stops). */
  onContinue?: () => void | Promise<void>;
  onEditLastUserMessage: (
    messageId: string,
    content: string,
  ) => void | Promise<void>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const anchorRefs = useRef(new Map<string, HTMLDivElement>());
  // Transcript Retry/Continue fire async actions; hold the button until the
  // request settles so a double-click cannot fire two.
  const [transcriptBusy, setTranscriptBusy] = useState(false);
  const runTranscriptAction = useCallback(
    async (action: () => void | Promise<void>) => {
      if (transcriptBusy) return;
      setTranscriptBusy(true);
      try {
        await action();
      } catch {
        toastError('The request failed — nothing was changed', 'Action failed');
      } finally {
        setTranscriptBusy(false);
      }
    },
    [transcriptBusy],
  );

  const streaming = chatState.activeRun?.streamingMessage;
  const toolActivity =
    chatState.activeRun?.toolActivity ?? chatState.settledToolActivity ?? [];
  const assistantSnippets =
    chatState.activeRun?.assistantSnippets ?? chatState.settledSnippets ?? [];
  const activeRunId = chatState.activeRun?.runId;
  const compactionNotice = chatState.compactionNotice;

  const turns = useMemo(() => groupMessageTurns(messages ?? []), [messages]);

  // Rail indexes turns (user prompt + agent work as a unit), not user messages
  // alone. Each anchor carries a compact tool count so the rail can show what
  // the agent actually did in that turn.
  const turnAnchors = useMemo(() => {
    return turns.map((turn) => {
      const isLastTurn = turn === turns[turns.length - 1];
      // toolCount only sums `tools` rows, which come from replies + live tool
      // activity. Pass only those, so the deps below list everything read;
      // snippets/stream/subagent/compaction steps never change the count.
      const steps = buildTurnTimeline({
        replies: turn.replies,
        liveActivity: isLastTurn ? toolActivity : EMPTY_TOOL_ACTIVITY,
        activeRunId,
      });
      const toolCount = steps.reduce(
        (sum, step) => (step.type === 'tools' ? sum + step.rows.length : sum),
        0,
      );

      const trimmed = turn.userMessage.content.trim();
      const attachmentCount = turn.userMessage.attachments?.length ?? 0;
      let label = trimmed;
      if (!label) {
        label =
          attachmentCount === 1
            ? '1 image'
            : attachmentCount > 1
              ? `${attachmentCount} images`
              : 'Message';
      }
      return { id: turn.userMessage.id, label, toolCount };
    });
  }, [turns, toolActivity, activeRunId]);

  const showRail = shouldShowConversationRail(turnAnchors.length);

  const registerAnchor = useCallback(
    (id: string, el: HTMLDivElement | null) => {
      if (el) anchorRefs.current.set(id, el);
      else anchorRefs.current.delete(id);
    },
    [],
  );

  const getAnchorElement = useCallback((id: string) => {
    return anchorRefs.current.get(id) ?? null;
  }, []);

  const {
    showJumpToBottom,
    followContent,
    jumpToBottomAndFollow,
    enableStickToBottom,
  } = useStickToBottom(scrollRef);

  useEffect(() => {
    followContent('auto');
  }, [
    messages?.length,
    streaming?.content,
    toolActivity.length,
    assistantSnippets.length,
    compactionNotice?.status,
    compactionNotice?.throughSeq,
    followContent,
  ]);

  const hasMessages = (messages?.length ?? 0) > 0;
  const lastTurnIndex = turns.length - 1;

  const latestAssistantMessageId = useMemo(() => {
    if (!messages?.length) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return messages[i].id;
    }
    return null;
  }, [messages]);

  const latestUserMessage = useMemo(() => {
    if (!messages?.length) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i];
    }
    return null;
  }, [messages]);
  const latestUserMessageId = latestUserMessage?.id ?? null;
  // An edit rewinds to the same ledger seq, so the new message reuses the
  // old id (`msg_<thread>_<seq>`); its createdAt is what changes.
  const latestUserKey = latestUserMessage
    ? `${latestUserMessage.id}:${latestUserMessage.createdAt}`
    : null;

  // Re-pin only when a new user message lands (send, edit, or thread open).
  // A reply settling into the ledger also grows the list, but must not yank
  // a reader who scrolled up back to the bottom.
  useEffect(() => {
    if (latestUserKey) enableStickToBottom();
  }, [latestUserKey, enableStickToBottom]);

  return (
    <div className="relative flex min-h-0 flex-1">
      {showJumpToBottom && (
        <div className="pointer-events-none absolute inset-x-0 bottom-20 z-30 flex justify-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="secondary"
                className="pointer-events-auto size-8 rounded-full border border-border/50 bg-card shadow-sm"
                onClick={jumpToBottomAndFollow}
                aria-label="Scroll to latest messages"
              >
                <ArrowDown className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Jump to latest</TooltipContent>
          </Tooltip>
        </div>
      )}
      {showRail && (
        <ConversationRail
          anchors={turnAnchors}
          scrollContainerRef={scrollRef}
          getAnchorElement={getAnchorElement}
        />
      )}
      <div
        ref={scrollRef}
        className={cn(
          'min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto scrollbar-gutter-stable [overflow-anchor:none]',
          // Keep the newest lines reachable above the floating plan card.
          isRunning && chatState.plan ? 'pb-40' : 'pb-5',
        )}
      >
        <div className="mx-auto w-full min-w-0 max-w-4xl px-4 py-5 sm:px-6">
          {!hasMessages && !isRunning && !streaming?.content && (
            <p className="type-ui text-center text-muted-foreground">
              Conversation will appear here.
            </p>
          )}

          <div className="flex flex-col gap-8">
            {turns.map((turn, index) => {
              const isLastTurn = index === lastTurnIndex;
              return (
                <TurnView
                  key={turn.userMessage.id}
                  turn={turn}
                  isLastTurn={isLastTurn}
                  isRunning={isRunning}
                  toolActivity={isLastTurn ? toolActivity : EMPTY_TOOL_ACTIVITY}
                  streaming={isLastTurn ? streaming : null}
                  assistantSnippets={isLastTurn ? assistantSnippets : EMPTY_SNIPPETS}
                  compactionNotice={compactionNotice}
                  activeRunId={activeRunId}
                  subagentActivity={
                    isLastTurn ? chatState.activeRun?.subagentActivity : undefined
                  }
                  latestAssistantMessageId={latestAssistantMessageId}
                  latestUserMessageId={latestUserMessageId}
                  plan={chatState.plan}
                  pendingChoices={chatState.pendingChoices}
                  limitNotice={chatState.limitNotice}
                  runStartedAt={chatState.activeRun?.runStartedAt}
                  transcriptBusy={transcriptBusy}
                  runTranscriptAction={runTranscriptAction}
                  onRetryLastResponse={onRetryLastResponse}
                  onEditLastUserMessage={onEditLastUserMessage}
                  onContinue={onContinue}
                  registerAnchor={registerAnchor}
                />
              );
            })}
          </div>

          {chatState.limitNotice ? (
            <div
              className={cn(
                'flex flex-wrap items-center gap-x-3 gap-y-1',
                // A stop the user didn't ask for (interrupt, limit) is the most
                // important line on screen: banner, not caption.
                isUserCancelled(chatState.limitNotice.reason)
                  ? 'px-1'
                  : 'rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-3 py-2',
              )}
              role="status"
            >
              <p
                className={cn(
                  isUserCancelled(chatState.limitNotice.reason)
                    ? 'type-caption text-muted-foreground'
                    : 'type-ui font-medium text-[var(--warning-fg)]',
                )}
                title={chatState.limitNotice.reason}
              >
                {stopReasonLabel(chatState.limitNotice.reason)}
              </p>
              {onContinue &&
              !isRunning &&
              isResumableStop(chatState.limitNotice.reason) ? (
                <button
                  type="button"
                  disabled={transcriptBusy}
                  onClick={() => void runTranscriptAction(() => onContinue())}
                  className="type-caption rounded-md border border-border px-2 py-0.5 text-foreground hover:bg-muted disabled:opacity-50"
                >
                  Continue
                </button>
              ) : null}
            </div>
          ) : null}

          {chatState.system1Notice ? (
            <p
              className="type-caption px-1 text-muted-foreground"
              role="status"
            >
              {system1NoticeText(chatState.system1Notice.report)}
            </p>
          ) : null}

          <div ref={endRef} className="h-6" />
        </div>
      </div>
    </div>
  );
}

const SYSTEM1_KIND_LABEL: Record<System1FallbackKind, string> = {
  unreachable: 'unreachable',
  timeout: 'timed out',
  http_error: 'HTTP error',
  bad_response: 'unexpected answer',
  inconsistent: 'inconsistent scores',
  breaker_open: 'paused after failures',
  busy: 'busy',
  budget_exhausted: 'time budget spent',
  internal: 'internal error',
};

/** One line: how many decisions fell back, why, and from which step. */
function system1NoticeText(report: System1RunReport): string {
  const total = report.fallbacks.reduce(
    (sum, fallback) => sum + fallback.count,
    0,
  );
  const parts = report.fallbacks.map(
    (fallback) =>
      `${SYSTEM1_KIND_LABEL[fallback.kind]} ×${fallback.count} from step ${fallback.firstIteration}`,
  );
  const what = `System 1 skipped ${total} decision${total === 1 ? '' : 's'} (${parts.join('; ')}).`;
  // Shadow only observes, so a skipped check changed nothing in the run.
  return report.mode === 'shadow'
    ? `${what} It was only observing; the run was not affected.`
    : `${what} Those steps used the default thinking level.`;
}

/** Attach compaction to the turn that produced it (by runId), else last turn. */
function turnOwnsCompaction(
  replies: Message[],
  notice: CompactionNotice | null,
  isLastTurn: boolean,
): boolean {
  if (!notice) return false;
  if (notice.status === 'running') return isLastTurn;
  if (notice.runId) {
    return replies.some((message) => message.runId === notice.runId);
  }
  return isLastTurn;
}

/** Quiet “still working” cue for model think gaps when no stream is visible. */
function TurnStatusLine({
  toolActivity,
  hasStreamingText,
  compacting,
  waitingForChoice,
  runStartedAt,
}: {
  toolActivity: ToolActivity[];
  hasStreamingText: boolean;
  compacting?: boolean;
  waitingForChoice?: boolean;
  /** Server start time of the run; shows the total next to the phase clock. */
  runStartedAt?: string;
}) {
  const running = toolActivity.find((t) => t.status === 'running');
  let label: string | null = null;

  if (compacting) {
    label = 'Compacting context…';
  } else if (waitingForChoice) {
    label = 'Waiting for a choice…';
  } else if (running) {
    label = `${running.toolName}…`;
  } else if (toolActivity.length > 0 && !hasStreamingText) {
    label = 'Working…';
  } else if (!hasStreamingText) {
    label = 'Working…';
  }

  // Each phase (tool call, think gap) gets its own clock keyed on the label.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    if (!label) return;
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [label]);

  if (!label) return null;
  // Re-rendered every second by the phase clock above.
  const started = runStartedAt ? Date.parse(runStartedAt) : NaN;
  const total = Number.isFinite(started)
    ? Math.max(0, Date.now() - started)
    : null;

  return (
    <p
      className="type-caption flex items-center gap-1.5 pl-0.5 text-left text-muted-foreground tabular-nums"
      aria-live="polite"
    >
      <span
        className="size-1.5 shrink-0 rounded-full bg-primary/80 animate-pulse"
        aria-hidden
      />
      {label}
      <span className="text-muted-foreground">
        {elapsed}s{total != null ? ` · ${formatDuration(total)} total` : ''}
      </span>
    </p>
  );
}

function MessageTimestamp({
  iso,
  durationMs,
  title,
}: {
  iso: string;
  durationMs?: number;
  /** Hover detail (finish time, time spent writing the answer). */
  title?: string;
}) {
  const text = formatMessageTime(iso);
  if (!text) return null;
  return (
    <time
      dateTime={iso}
      title={title}
      className="type-caption text-muted-foreground tabular-nums"
    >
      {text}
      {durationMs != null && ` · ${formatDuration(durationMs)}`}
    </time>
  );
}

/**
 * Footer timing for a turn's final answer: when the run started and how long
 * the whole run took (every model call, tool and sub-agent), not just the
 * last call that wrote the answer. Old ledger rows have no runDurationMs:
 * fall back to the gap from the user's message (over-counts a Retry).
 */
function answerTiming(
  message: Message,
  turnStartedAt?: string,
): { iso: string; durationMs?: number; title?: string } {
  const finished = Date.parse(message.createdAt);
  let total = message.runDurationMs;
  if (total == null && turnStartedAt && Number.isFinite(finished)) {
    const start = Date.parse(turnStartedAt);
    if (Number.isFinite(start) && finished >= start) total = finished - start;
  }
  if (total == null || !Number.isFinite(finished)) {
    return { iso: message.createdAt, durationMs: message.durationMs };
  }
  const writing =
    message.durationMs != null
      ? ` · writing the answer ${formatDuration(message.durationMs)}`
      : '';
  return {
    iso: new Date(finished - total).toISOString(),
    durationMs: total,
    title: `Finished ${formatMessageTime(message.createdAt)}${writing}`,
  };
}

/**
 * One meta row per message: timestamp left, actions right. Always visible —
 * hover-gating hides the primary affordances on touch and during streaming.
 */
function MessageMetaRow({
  iso,
  durationMs,
  title,
  workSummary,
  children,
}: {
  iso?: string;
  durationMs?: number;
  title?: string;
  /** What the turn did, e.g. "Edited 3 files · 12 tool calls". */
  workSummary?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-1 flex min-w-0 items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <MessageTimestamp
          iso={iso ?? ''}
          durationMs={durationMs}
          title={title}
        />
        {workSummary ? (
          <span className="type-caption truncate text-subtle-foreground">
            · {workSummary}
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center">{children}</div>
    </div>
  );
}

// Stable empty arrays so non-last turns get referentially identical props and
// memo can skip them when only the streaming turn changes.
const EMPTY_TOOL_ACTIVITY: ToolActivity[] = [];
const EMPTY_SNIPPETS: AssistantSnippet[] = [];

type TurnViewProps = {
  turn: MessageTurn;
  isLastTurn: boolean;
  isRunning: boolean;
  toolActivity: ToolActivity[];
  streaming: { id: string; content: string } | null | undefined;
  assistantSnippets: AssistantSnippet[];
  compactionNotice: CompactionNotice | null;
  activeRunId: string | undefined;
  subagentActivity: SubagentActivity[] | undefined;
  latestAssistantMessageId: string | null;
  latestUserMessageId: string | null;
  plan: ThreadPlan | null;
  pendingChoices: PendingChoice[];
  limitNotice: LimitNotice | null;
  runStartedAt: string | undefined;
  transcriptBusy: boolean;
  runTranscriptAction: (action: () => void | Promise<void>) => void;
  onRetryLastResponse: () => void | Promise<void>;
  onEditLastUserMessage: (messageId: string, content: string) => void | Promise<void>;
  onContinue?: () => void | Promise<void>;
  registerAnchor: (id: string, el: HTMLDivElement | null) => void;
};

const TurnView = memo(function TurnView({
  turn,
  isLastTurn,
  isRunning,
  toolActivity,
  streaming,
  assistantSnippets,
  compactionNotice,
  activeRunId,
  subagentActivity,
  latestAssistantMessageId,
  latestUserMessageId,
  plan,
  pendingChoices,
  limitNotice,
  runStartedAt,
  transcriptBusy,
  runTranscriptAction,
  onRetryLastResponse,
  onEditLastUserMessage,
  onContinue,
  registerAnchor,
}: TurnViewProps) {
  const turnCompaction = turnOwnsCompaction(
    turn.replies,
    compactionNotice,
    isLastTurn,
  )
    ? compactionNotice
    : null;

  // F3/F4: memoize the timeline + work summary per turn. Non-last turns have
  // stable inputs (empty live arrays, no streaming), so this runs once.
  const steps = useMemo(
    () =>
      buildTurnTimeline({
        replies: turn.replies,
        liveActivity: toolActivity,
        snippets: assistantSnippets,
        activeRunId,
        streaming,
        compaction: turnCompaction,
        subagentActivity,
      }),
    [
      turn.replies,
      toolActivity,
      assistantSnippets,
      activeRunId,
      streaming,
      turnCompaction,
      subagentActivity,
    ],
  );

  const workSummary = useMemo(() => summarizeTurnWork(steps), [steps]);

  const latestReplyStep = steps.find(
    (step): step is Extract<typeof step, { type: 'assistant' }> =>
      step.type === 'assistant' &&
      step.message.id === latestAssistantMessageId,
  );
  // The thread's latest assistant reply lives in this turn — retry is only
  // valid there (retry rewinds the ledger to that point).
  const isLatestTurnReply = latestReplyStep !== undefined;
  const footerAfterSteps =
    latestReplyStep !== undefined && steps.at(-1) !== latestReplyStep;
  const showSteps =
    turn.replies.length > 0 ||
    toolActivity.length > 0 ||
    assistantSnippets.length > 0 ||
    Boolean(streaming?.content) ||
    Boolean(turnCompaction);

  return (
    <section
      ref={(el) => registerAnchor(turn.userMessage.id, el as HTMLDivElement | null)}
      id={`conversation-anchor-${turn.userMessage.id}`}
      className="flex flex-col gap-3.5 scroll-mt-6"
      aria-label="Conversation turn"
      style={
        isLastTurn
          ? undefined
          : {
              contentVisibility: 'auto',
              containIntrinsicSize: 'auto 600px',
            }
      }
    >
      <UserMessage
        message={turn.userMessage}
        canEdit={isLastTurn && turn.userMessage.id === latestUserMessageId}
        hasResponseBelow={
          isLastTurn &&
          (turn.replies.length > 0 ||
            isRunning ||
            Boolean(streaming?.content) ||
            Boolean(turnCompaction))
        }
        onEditSubmit={onEditLastUserMessage}
      />

      {isLastTurn && !isRunning && !showSteps ? (
        <div className="flex items-center gap-3 px-1" role="status">
          <p className="type-caption text-muted-foreground">
            {isUserCancelled(limitNotice?.reason ?? '')
              ? 'You stopped this run before it replied.'
              : 'The run failed to start.'}
          </p>
          <button
            type="button"
            disabled={transcriptBusy}
            onClick={() => void runTranscriptAction(() => onRetryLastResponse())}
            className="type-caption rounded-md border border-border px-2 py-0.5 text-foreground hover:bg-muted disabled:opacity-50"
          >
            Retry
          </button>
        </div>
      ) : null}

      {isLastTurn && !isRunning ? <PlanChip plan={plan} /> : null}

      {showSteps ? (
        <div className="flex min-w-0 flex-col gap-3">
          {steps.map((step) => {
            if (step.type === 'assistant') {
              const isLatestAssistant =
                step.message.id === latestAssistantMessageId;
              return (
                <AssistantMessage
                  key={step.message.id}
                  message={step.message}
                  showMeta={!footerAfterSteps}
                  workSummary={isLatestAssistant ? workSummary : undefined}
                  turnStartedAt={turn.userMessage.createdAt}
                  showRetry={!isRunning && isLatestAssistant}
                  onRetry={onRetryLastResponse}
                  retryDisabled={isRunning}
                />
              );
            }
            if (step.type === 'snippet') {
              // Render through AssistantMessage with the same key the
              // committed ledger row will use (envelope.messageId), so the
              // settle swap reconciles in place instead of remounting.
              return (
                <AssistantMessage
                  key={step.messageId}
                  showMeta={false}
                  message={{
                    id: step.messageId,
                    threadId: turn.userMessage.threadId,
                    runId: activeRunId ?? null,
                    role: 'assistant',
                    content: step.content,
                    status: 'complete',
                    createdAt: turn.userMessage.createdAt,
                  }}
                />
              );
            }
            if (step.type === 'tools') {
              return <ToolStepList key={step.key} rows={step.rows} />;
            }
            if (step.type === 'compaction') {
              return (
                <CompactionCard
                  key={`compaction-${step.notice.runId ?? step.notice.throughSeq}`}
                  notice={step.notice}
                />
              );
            }
            if (step.type === 'subagent') {
              return (
                <SubagentCard
                  key={`subagent-${step.activity.subRunId}`}
                  activity={step.activity}
                />
              );
            }
            return (
              <AssistantMessage
                key={step.messageId}
                showMeta={false}
                streaming
                message={{
                  id: step.messageId,
                  threadId: turn.userMessage.threadId,
                  runId: activeRunId ?? null,
                  role: 'assistant',
                  content: step.content,
                  status: 'complete',
                  createdAt: turn.userMessage.createdAt,
                }}
              />
            );
          })}
        </div>
      ) : null}

      {footerAfterSteps && latestReplyStep ? (
        <TurnFooter
          message={latestReplyStep.message}
          workSummary={workSummary}
          turnStartedAt={turn.userMessage.createdAt}
          showRetry={!isRunning && isLatestTurnReply}
          onRetry={onRetryLastResponse}
          retryDisabled={isRunning}
        />
      ) : null}

      {isLastTurn && (isRunning || compactionNotice?.status === 'running') ? (
        <TurnStatusLine
          toolActivity={toolActivity}
          hasStreamingText={Boolean(streaming?.content)}
          compacting={compactionNotice?.status === 'running'}
          waitingForChoice={pendingChoices.length > 0}
          {...(runStartedAt ? { runStartedAt } : {})}
        />
      ) : null}
    </section>
  );
});

const AssistantMessage = memo(function AssistantMessage({
  message,
  showMeta = true,
  workSummary,
  showRetry,
  onRetry,
  retryDisabled,
  turnStartedAt,
  streaming = false,
}: {
  message: Message;
  /** Meta footer (start time · run duration · Copy) on every committed reply. */
  showMeta?: boolean;
  workSummary?: string;
  /** The turn's user message time; fallback start for old rows. */
  turnStartedAt?: string;
  showRetry?: boolean;
  onRetry?: () => void | Promise<void>;
  retryDisabled?: boolean;
  /** True while tokens are still arriving for this reply. */
  streaming?: boolean;
}) {
  if (!message.content.trim()) return null;

  return (
    <div className="min-w-0 max-w-full">
      <article className="chat-prose type-body min-w-0 max-w-full">
        <AgentMarkdown content={message.content} streaming={streaming} />
      </article>
      {showMeta ? (
        <TurnFooter
          message={message}
          workSummary={workSummary}
          turnStartedAt={turnStartedAt}
          showRetry={showRetry}
          onRetry={onRetry}
          retryDisabled={retryDisabled}
        />
      ) : null}
    </div>
  );
});

/** Time · work summary on the left, Copy/Retry for the final reply on the right. */
function TurnFooter({
  message,
  workSummary,
  turnStartedAt,
  showRetry,
  onRetry,
  retryDisabled,
}: {
  message: Message;
  workSummary?: string;
  turnStartedAt?: string;
  showRetry?: boolean;
  onRetry?: () => void | Promise<void>;
  retryDisabled?: boolean;
}) {
  const timing = answerTiming(message, turnStartedAt);
  return (
    <MessageMetaRow
      iso={timing.iso}
      durationMs={timing.durationMs}
      workSummary={workSummary}
      {...(timing.title ? { title: timing.title } : {})}
    >
      <MessageActions
        content={message.content}
        align="start"
        showRetry={showRetry}
        onRetry={onRetry}
        disabled={retryDisabled}
      />
    </MessageMetaRow>
  );
}
