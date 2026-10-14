import {
  occupiedFromUsage,
  type AgentEvent,
  type Message,
} from '@org/agent-models';
import { setContextAnchor } from '../lib/context-anchor';
import { addMessage, updateRun, addRun } from './db';

/**
 * Ephemeral UI state derived from the event stream.
 * Durable pieces: IndexedDB (messages/runs) and context occupancy in localStorage.
 */
export type ToolActivity = {
  toolCallId: string;
  toolName: string;
  status: 'running' | 'done' | 'failed';
  durationMs?: number;
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
 * Pure AgentEvent → ChatState. Persistence is persistChatEffects.
 * Updates lastSeq so SSE can reconnect without full replay.
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
              ? { ...t, status: 'done', durationMs: event.durationMs }
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
    case 'limit.hit': {
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
 * IndexedDB / localStorage writes for events that mutate durable chat state.
 * Call after applyChatEvent with the pre-apply state when needed for model.
 */
export async function persistChatEffects(
  prev: ChatState,
  event: AgentEvent,
  threadId: string,
): Promise<void> {
  switch (event.type) {
    case 'run.started': {
      await addRun({
        id: event.runId,
        threadId,
        triggerMessageId: '',
        status: 'running',
        iteration: 0,
        toolCallCount: 0,
        model: event.model,
        streaming: event.streaming,
        mode: event.mode,
        startedAt: new Date().toISOString(),
        completedAt: null,
        error: null,
      });
      return;
    }

    case 'assistant.completed': {
      const message: Message = {
        id: event.messageId,
        threadId,
        runId: event.runId,
        role: 'assistant',
        content: event.content,
        status: 'complete',
        createdAt: new Date().toISOString(),
      };
      await addMessage(message);
      return;
    }

    case 'run.completed': {
      await updateRun(event.runId, {
        status: 'completed',
        iteration: event.iterations,
        toolCallCount: event.toolCalls,
        completedAt: new Date().toISOString(),
      });
      return;
    }

    case 'run.error': {
      await updateRun(event.runId, {
        status: 'error',
        completedAt: new Date().toISOString(),
        error: event.error,
      });
      return;
    }

    case 'turn.completed': {
      const usage = event.usage;
      const occupied = usage ? occupiedFromUsage(usage) : undefined;
      if (occupied !== undefined && prev.activeRun) {
        setContextAnchor(threadId, {
          occupiedTokens: occupied,
          model: prev.activeRun.model,
          measuredAt: new Date().toISOString(),
        });
      }
      return;
    }

    default:
      return;
  }
}
