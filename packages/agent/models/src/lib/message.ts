/**
 * A durable conversational message, persisted client-side.
 *
 * Roles follow the OpenAI Chat Completions convention so the same shape
 * can be fed back to the model as context.
 */
export type MessageRole = 'user' | 'assistant' | 'tool';

export type MessageStatus = 'complete' | 'interrupted';

/**
 * An image attached to a user message.
 * V1 stores a data URL (base64) for both local persistence and model wire.
 */
export type MessageAttachment = {
  id: string;
  mimeType: string;
  /** `data:image/...;base64,...` for V1 local persistence + model wire. */
  dataUrl: string;
  name?: string;
};

export interface Message {
  id: string;
  threadId: string;
  runId: string | null;
  role: MessageRole;
  content: string;
  /** Image attachments on user messages (vision models). */
  attachments?: MessageAttachment[];
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
