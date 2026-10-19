import {
  occupiedFromUsage,
  type AgentEvent,
  type ContextReport,
  type RunPosture,
  type Snapshot,
} from '@org/agent-models';
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
  status: 'running' | 'done' | 'failed';
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
  status: 'running' | 'completed' | 'error';
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
  /** Latest prompt+completion from turn.completed in this run. */
  occupiedTokens?: number;
  /** True when occupiedTokens already includes the current streamingMessage. */
  occupiedCoversStream?: boolean;
};

export type ChatState = {
  activeRun: ChatRunState | null;
  /** Survives run.completed so the compaction card can render after the turn. */
  compactionNotice: CompactionNotice | null;
};

export function initialChatState(): ChatState {
  return { activeRun: null, compactionNotice: null };
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
        compactionNotice: state.compactionNotice,
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
          ? { messageId: event.messageId, content: event.content, seq: event.seq }
          : null;
      return {
        ...state,
        activeRun: {
          ...state.activeRun,
          streamingMessage: null,
          ...(snippet
            ? { assistantSnippets: [...state.activeRun.assistantSnippets, snippet] }
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
      return {
        ...state,
        activeRun: {
          ...state.activeRun,
          toolActivity: state.activeRun.toolActivity.map((t) =>
            t.toolCallId === event.toolCallId
              ? {
                  ...t,
                  status: 'done',
                  durationMs: event.durationMs,
                  resultPreview: event.resultPreview,
                }
              : t,
          ),
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
      return {
        ...state,
        activeRun: {
          ...state.activeRun,
          status: 'completed',
          streamingMessage: null,
          lastSeq,
        },
      };
    }

    case 'run.settled': {
      return {
        activeRun: null,
        compactionNotice: state.compactionNotice,
      };
    }

    case 'run.error': {
      return {
        activeRun: null,
        compactionNotice: state.compactionNotice,
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
        },
      };
    }

    case 'turn.started':
    case 'limit.hit':
    case 'approval.requested':
    case 'approval.resolved':
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
      setContextAnchor(threadId, {
        occupiedTokens: occupied,
        model: prev.activeRun.model,
        measuredAt: new Date().toISOString(),
      });
    }
  }
}
