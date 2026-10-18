import {
  occupiedFromUsage,
  type AgentEvent,
  type ContextReport,
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
  durationMs?: number;
  argsPreview?: unknown;
  resultPreview?: unknown;
};

export type ChatRunState = {
  runId: string;
  status: 'running' | 'completed' | 'error';
  model: string;
  streamingMessage: { id: string; content: string } | null;
  toolActivity: ToolActivity[];
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
};

export function initialChatState(): ChatState {
  return { activeRun: null };
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
          streamingMessage: null,
          toolActivity: [],
          lastSeq,
          ...(event.estimatedPromptTokens !== undefined
            ? { estimatedPromptTokens: event.estimatedPromptTokens }
            : {}),
          ...(event.contextReport
            ? { contextReport: event.contextReport }
            : {}),
        },
      };
    }

    case 'assistant.started': {
      if (!state.activeRun) return state;
      return {
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
      return {
        activeRun: {
          ...state.activeRun,
          streamingMessage: null,
          lastSeq,
        },
      };
    }

    case 'tool.started': {
      if (!state.activeRun) return state;
      return {
        activeRun: {
          ...state.activeRun,
          toolActivity: [
            ...state.activeRun.toolActivity,
            {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              status: 'running',
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
        activeRun: {
          ...state.activeRun,
          toolActivity: state.activeRun.toolActivity.map((t) =>
            t.toolCallId === event.toolCallId ? { ...t, status: 'failed' } : t,
          ),
          lastSeq,
        },
      };
    }

    case 'run.completed':
    case 'run.error': {
      return { activeRun: null };
    }

    case 'turn.completed': {
      if (!state.activeRun) return state;
      const usage = event.usage;
      const occupied = usage ? occupiedFromUsage(usage) : undefined;
      return {
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
