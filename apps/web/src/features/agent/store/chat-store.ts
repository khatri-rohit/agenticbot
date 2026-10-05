import type { AgentEvent, Message } from '@org/agent-models';
import {
  addMessage,
  updateRun,
  addRun,
} from './db';

/**
 * Ephemeral UI state derived from the event stream.
 * This is NOT durable — it lives in React state and is rebuilt from
 * IndexedDB on page reload (plus SSE reconnection for active runs).
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
  streamingMessage: { id: string; content: string } | null;
  toolActivity: ToolActivity[];
  lastSeq: number;
};

export type ChatState = {
  activeRun: ChatRunState | null;
};

/**
 * Initial empty state.
 */
export function initialChatState(): ChatState {
  return { activeRun: null };
}

/**
 * Pure reducer over AgentEvent → ChatState.
 * Also performs side-effects (IndexedDB writes) for durable state.
 *
 * Call this from a React event handler.
 */
export async function reduceChatState(
  state: ChatState,
  event: AgentEvent,
  threadId: string,
): Promise<ChatState> {
  // Track the last seq for reconnection
  const lastSeq = Math.max(state.activeRun?.lastSeq ?? 0, event.seq);

  switch (event.type) {
    case 'run.started': {
      // Create the run record in IndexedDB
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

      return {
        activeRun: {
          runId: event.runId,
          status: 'running',
          streamingMessage: null,
          toolActivity: [],
          lastSeq,
        },
      };
    }

    case 'assistant.started': {
      if (!state.activeRun) return state;
      return {
        activeRun: {
          ...state.activeRun,
          streamingMessage: { id: event.messageId, content: '' },
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

      // Persist the final assistant message to IndexedDB
      const now = new Date().toISOString();
      const message: Message = {
        id: event.messageId,
        threadId,
        runId: event.runId,
        role: 'assistant',
        content: event.content,
        status: 'complete',
        createdAt: now,
      };
      await addMessage(message);

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
            t.toolCallId === event.toolCallId
              ? { ...t, status: 'failed' }
              : t,
          ),
          lastSeq,
        },
      };
    }

    case 'run.completed': {
      if (!state.activeRun) return state;

      await updateRun(event.runId, {
        status: 'completed',
        iteration: event.iterations,
        toolCallCount: event.toolCalls,
        completedAt: new Date().toISOString(),
      });

      return {
        activeRun: {
          ...state.activeRun,
          status: 'completed',
          lastSeq,
        },
      };
    }

    case 'run.error': {
      if (!state.activeRun) return state;

      await updateRun(event.runId, {
        status: 'error',
        completedAt: new Date().toISOString(),
        error: event.error,
      });

      return {
        activeRun: {
          ...state.activeRun,
          status: 'error',
          lastSeq,
        },
      };
    }

    case 'turn.started':
    case 'turn.completed':
    case 'limit.hit':
      // These don't change UI state — just update the cursor
      if (!state.activeRun) return state;
      return {
        activeRun: {
          ...state.activeRun,
          lastSeq,
        },
      };

    default:
      return state;
  }
}