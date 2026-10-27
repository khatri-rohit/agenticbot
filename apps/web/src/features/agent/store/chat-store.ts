import {
  isLimitSkipToolContent,
  occupiedFromUsage,
  type AgentEvent,
  type ChoiceOption,
  type ContextReport,
  type RunPosture,
  type Snapshot,
  type ThreadPlan,
} from '@agent/agent-models';
import { setContextAnchor } from '../lib/context-anchor';

/**
 * Ephemeral UI state derived from the event stream.
 * Durable chat state lives in the host ledger (apps/api); this reducer
 * exists only for the live run view. `persistChatEffects` keeps the
 * localStorage context anchor in sync with provider usage.
 */
export type ToolActivity = {
  toolCallId: string;
  toolName: string;
  status: 'running' | 'done' | 'failed' | 'skipped';
  /** Event seq — orders live tools against settled assistant snippets. */
  seq: number;
  durationMs?: number;
  argsPreview?: unknown;
  resultPreview?: unknown;
};

/** Host compaction activity for a turn (SSE or ledger hydrate). */
export type CompactionNotice = {
  runId: string | null;
  threadId: string;
  status: 'running' | 'done';
  throughSeq: number;
  brief: string;
  summary: string;
  createdAt: string;
};

export type AssistantSnippet = {
  messageId: string;
  content: string;
  /** Event seq — orders snippets against live tool activity. */
  seq: number;
};

export type ChatRunState = {
  runId: string;
  status: 'running' | 'completed' | 'incomplete' | 'error';
  model: string;
  /** Host-applied posture for this run (from run.started). */
  posture: RunPosture;
  streamingMessage: { id: string; content: string } | null;
  toolActivity: ToolActivity[];
  /** Assistant messages settled mid-run (assistant.completed), in event order. */
  assistantSnippets: AssistantSnippet[];
  lastSeq: number;
  /** Heuristic from run.started until provider usage arrives. */
  estimatedPromptTokens?: number;
  contextReport?: ContextReport;
  /** Last prompt tokens from turn.completed in this run. */
  occupiedTokens?: number;
  /** True when occupiedTokens already includes the current streamingMessage. */
  occupiedCoversStream?: boolean;
};

export type LimitNotice = {
  runId: string;
  reason: string;
};

/** Build a limitNotice from an incomplete run, or undefined if the run completed. */
export function limitNoticeFromIncomplete(
  run: { runId: string; incomplete?: boolean; limitReason?: string } | null | undefined,
): LimitNotice | undefined {
  if (!run?.incomplete) return undefined;
  return { runId: run.runId, reason: run.limitReason ?? 'Run stopped early (incomplete).' };
}

export type PendingChoice = {
  choiceId: string;
  runId: string;
  question: string;
  options: ChoiceOption[];
};

export type ChatState = {
  activeRun: ChatRunState | null;
  /** Survives run.completed so the compaction card can render after the turn. */
  compactionNotice: CompactionNotice | null;
  /** Last limit.hit / incomplete finish, until the next run. */
  limitNotice: LimitNotice | null;
  /** Thread plan. Live above the input while running; pinned as a chip
   *  under the anchor user message once the run settles. */
  plan: ThreadPlan | null;
  /** Live pauses; cleared on resolve / run end. */
  pendingChoices: PendingChoice[];
  /** Snippets from the just-settled run, kept until the ledger refetch
   *  lands so the response doesn't flash off→on at run.settled. */
  settledSnippets: AssistantSnippet[];
  /** Tool activity from the just-settled run, same lifetime as settledSnippets. */
  settledToolActivity: ToolActivity[];
};

export function initialChatState(): ChatState {
  return {
    activeRun: null,
    settledSnippets: [],
    settledToolActivity: [],
    compactionNotice: null,
    limitNotice: null,
    plan: null,
    pendingChoices: [],
  };
}

export function noticeFromSnapshot(
  snapshot: Snapshot,
  runId: string | null = null,
): CompactionNotice {
  return {
    runId,
    threadId: snapshot.threadId,
    status: 'done',
    throughSeq: snapshot.throughSeq,
    brief: snapshot.brief,
    summary: snapshot.summary,
    createdAt: snapshot.createdAt,
  };
}

/** True when the stream skipped seqs; recover from the ledger, not SSE. */
export function hasSseSeqGap(lastSeq: number, eventSeq: number): boolean {
  return eventSeq > lastSeq + 1;
}

/**
 * Pure AgentEvent → ChatState. Updates lastSeq so SSE can reconnect
 * without full replay.
 */
export function applyChatEvent(state: ChatState, event: AgentEvent): ChatState {
  const lastSeq = Math.max(state.activeRun?.lastSeq ?? 0, event.seq);

  switch (event.type) {
    case 'run.started': {
      return {
        activeRun: {
          runId: event.runId,
          status: 'running',
          model: event.model,
          posture: event.posture === 'ask' ? 'ask' : 'agent',
          streamingMessage: null,
          toolActivity: [],
          assistantSnippets: [],
          lastSeq,
          ...(event.estimatedPromptTokens !== undefined
            ? { estimatedPromptTokens: event.estimatedPromptTokens }
            : {}),
          ...(event.contextReport
            ? { contextReport: event.contextReport }
            : {}),
        },
        settledSnippets: [],
        settledToolActivity: [],
        compactionNotice: state.compactionNotice,
        limitNotice: null,
        plan: state.plan,
        pendingChoices: [],
      };
    }

    case 'assistant.started': {
      if (!state.activeRun) return state;
      return {
        ...state,
        activeRun: {
          ...state.activeRun,
          streamingMessage: { id: event.messageId, content: '' },
          occupiedCoversStream: false,
          lastSeq,
        },
      };
    }

    case 'assistant.delta': {
      if (!state.activeRun?.streamingMessage) return state;
      return {
        ...state,
        activeRun: {
          ...state.activeRun,
          streamingMessage: {
            ...state.activeRun.streamingMessage,
            content: state.activeRun.streamingMessage.content + event.delta,
          },
          lastSeq,
        },
      };
    }

    case 'assistant.completed': {
      if (!state.activeRun) return state;
      // Tool-only turns emit completed with empty content; nothing to settle.
      const snippet =
        event.content && event.content.trim().length > 0
          ? {
              messageId: event.messageId,
              content: event.content,
              seq: event.seq,
            }
          : null;
      return {
        ...state,
        activeRun: {
          ...state.activeRun,
          streamingMessage: null,
          ...(snippet
            ? {
                assistantSnippets: [
                  ...state.activeRun.assistantSnippets,
                  snippet,
                ],
              }
            : {}),
          lastSeq,
        },
      };
    }

    case 'tool.started': {
      if (!state.activeRun) return state;
      return {
        ...state,
        activeRun: {
          ...state.activeRun,
          toolActivity: [
            ...state.activeRun.toolActivity,
            {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              status: 'running',
              seq: event.seq,
              argsPreview: event.argsPreview,
            },
          ],
          lastSeq,
        },
      };
    }

    case 'tool.completed': {
      if (!state.activeRun) return state;
      const preview =
        typeof event.resultPreview === 'string' ? event.resultPreview : '';
      const doneStatus = isLimitSkipToolContent(preview)
        ? ('skipped' as const)
        : ('done' as const);
      const existing = state.activeRun.toolActivity.some(
        (t) => t.toolCallId === event.toolCallId,
      );
      const toolActivity = existing
        ? state.activeRun.toolActivity.map((t) =>
            t.toolCallId === event.toolCallId
              ? {
                  ...t,
                  status: doneStatus,
                  durationMs: event.durationMs,
                  resultPreview: event.resultPreview,
                }
              : t,
          )
        : [
            ...state.activeRun.toolActivity,
            {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              status: doneStatus,
              seq: event.seq,
              durationMs: event.durationMs,
              resultPreview: event.resultPreview,
            },
          ];
      return {
        ...state,
        activeRun: {
          ...state.activeRun,
          toolActivity,
          lastSeq,
        },
      };
    }

    case 'tool.failed': {
      if (!state.activeRun) return state;
      return {
        ...state,
        activeRun: {
          ...state.activeRun,
          toolActivity: state.activeRun.toolActivity.map((t) =>
            t.toolCallId === event.toolCallId ? { ...t, status: 'failed' } : t,
          ),
          lastSeq,
        },
      };
    }

    case 'context.compacting': {
      return {
        ...state,
        activeRun: state.activeRun
          ? { ...state.activeRun, lastSeq }
          : state.activeRun,
        compactionNotice: {
          runId: event.runId,
          threadId: event.threadId,
          status: 'running',
          throughSeq: state.compactionNotice?.throughSeq ?? 0,
          brief: state.compactionNotice?.brief ?? '',
          summary: state.compactionNotice?.summary ?? '',
          createdAt: state.compactionNotice?.createdAt ?? '',
        },
      };
    }

    case 'context.compacted': {
      return {
        ...state,
        activeRun: state.activeRun
          ? { ...state.activeRun, lastSeq }
          : state.activeRun,
        compactionNotice: {
          runId: event.runId,
          threadId: event.threadId,
          status: 'done',
          throughSeq: event.throughSeq,
          brief: event.brief,
          summary: event.summary,
          createdAt: event.createdAt,
        },
      };
    }

    case 'run.completed': {
      // Model loop done — keep activeRun until run.settled so compaction
      // can appear in the turn trail like a late tool step.
      if (!state.activeRun) return state;
      const incomplete = event.incomplete === true;
      const notice = limitNoticeFromIncomplete({
        runId: event.runId,
        incomplete,
        limitReason: event.limitReason,
      });
      return {
        ...state,
        ...(notice ? { limitNotice: notice } : {}),
        activeRun: {
          ...state.activeRun,
          status: incomplete ? 'incomplete' : 'completed',
          streamingMessage: null,
          lastSeq,
        },
      };
    }

    case 'run.settled': {
      // Keep snippets/tools alive until the ledger refetch lands — otherwise
      // the response flashes off→on between activeRun nulling and messages update.
      return {
        activeRun: null,
        settledSnippets: state.activeRun?.assistantSnippets ?? [],
        settledToolActivity: state.activeRun?.toolActivity ?? [],
        compactionNotice: state.compactionNotice,
        limitNotice: state.limitNotice,
        plan: state.plan,
        pendingChoices: [],
      };
    }

    case 'run.error': {
      return {
        activeRun: null,
        settledSnippets: state.activeRun?.assistantSnippets ?? [],
        settledToolActivity: state.activeRun?.toolActivity ?? [],
        compactionNotice: state.compactionNotice,
        limitNotice: state.limitNotice,
        plan: state.plan,
        pendingChoices: [],
      };
    }

    case 'plan.updated': {
      // Settle is the closing bracket: late plan writes after run end are
      // an SSE race, not new state.
      if (!state.activeRun) return state;
      return {
        ...state,
        plan: event.plan,
        activeRun: state.activeRun
          ? { ...state.activeRun, lastSeq }
          : state.activeRun,
      };
    }

    case 'turn.completed': {
      if (!state.activeRun) return state;
      const usage = event.usage;
      const occupied = usage ? occupiedFromUsage(usage) : undefined;
      return {
        ...state,
        activeRun: {
          ...state.activeRun,
          lastSeq,
          ...(occupied !== undefined
            ? {
                occupiedTokens: occupied,
                occupiedCoversStream: Boolean(
                  state.activeRun.streamingMessage?.content,
                ),
              }
            : {}),
          ...(event.contextReport
            ? { contextReport: event.contextReport }
            : {}),
        },
      };
    }

    case 'limit.hit': {
      if (!state.activeRun) {
        return {
          ...state,
          limitNotice: { runId: event.runId, reason: event.reason },
        };
      }
      return {
        ...state,
        limitNotice: { runId: event.runId, reason: event.reason },
        activeRun: {
          ...state.activeRun,
          lastSeq,
        },
      };
    }

    case 'choice.requested': {
      const next: PendingChoice = {
        choiceId: event.choiceId,
        runId: event.runId,
        question: event.question,
        options: event.options,
      };
      return {
        ...state,
        pendingChoices: [
          ...state.pendingChoices.filter(
            (item) => item.choiceId !== event.choiceId,
          ),
          next,
        ],
        activeRun: state.activeRun
          ? { ...state.activeRun, lastSeq }
          : state.activeRun,
      };
    }

    case 'choice.resolved': {
      return {
        ...state,
        pendingChoices: state.pendingChoices.filter(
          (item) => item.choiceId !== event.choiceId,
        ),
        activeRun: state.activeRun
          ? { ...state.activeRun, lastSeq }
          : state.activeRun,
      };
    }

    case 'turn.started':
    case 'memory.updated': {
      if (!state.activeRun) return state;
      return {
        ...state,
        activeRun: {
          ...state.activeRun,
          lastSeq,
        },
      };
    }

    default:
      return state;
  }
}

/**
 * Durable side effects for events that mutate client-held chat state.
 * Only the context anchor (localStorage) survives — the ledger owns history.
 */
export async function persistChatEffects(
  prev: ChatState,
  event: AgentEvent,
  threadId: string,
): Promise<void> {
  if (event.type === 'turn.completed' && prev.activeRun) {
    const usage = event.usage;
    const occupied = usage ? occupiedFromUsage(usage) : undefined;
    if (occupied !== undefined) {
      const report = event.contextReport ?? prev.activeRun.contextReport;
      setContextAnchor(threadId, {
        occupiedTokens: occupied,
        model: prev.activeRun.model,
        measuredAt: new Date().toISOString(),
        ...(report
          ? {
              windowTokens: report.budget.windowTokens,
              layers: report.layers,
              reserve: report.budget.outputReserveTokens,
              ...(report.windowSource
                ? { windowSource: report.windowSource }
                : {}),
            }
          : {}),
      });
    }
  }
}
