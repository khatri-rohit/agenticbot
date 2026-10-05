/**
 * A durable conversational message, persisted client-side.
 *
 * Roles follow the OpenAI Chat Completions convention so the same shape
 * can be fed back to the model as context.
 */
export type MessageRole = 'user' | 'assistant' | 'tool';

export type MessageStatus = 'complete' | 'interrupted';

export interface Message {
  id: string;
  threadId: string;
  runId: string | null;
  role: MessageRole;
  content: string;
  /** Present only on assistant messages that requested tool calls. */
  toolCalls?: PendingToolCall[];
  /** Present only on tool-role messages, linking back to the assistant tool call. */
  toolCallId?: string;
  status: MessageStatus;
  createdAt: string;
}

/**
 * A tool call reconstructed from the model's response.
 *
 * In streaming mode this is assembled fragment-by-fragment from chunk deltas;
 * in non-streaming mode it arrives complete. Both paths produce the same shape.
 */
export interface PendingToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}