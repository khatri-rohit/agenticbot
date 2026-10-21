import type { ThreadKind } from './thread.js';

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
 * `type` is optional so older ledger rows without it still parse as images.
 */
export type ImageAttachment = {
  type?: 'image';
  id: string;
  mimeType: string;
  /** `data:image/...;base64,...` for V1 local persistence + model wire. */
  dataUrl: string;
  name?: string;
};

/**
 * Reference to another thread packed into this run's context.
 * Host loads a budgeted extract at assemble time; this object is a pointer.
 */
export type ThreadMentionAttachment = {
  type: 'thread';
  id: string;
  threadId: string;
  title: string;
  kind: ThreadKind;
  workspaceRoot?: string;
};

export type MessageAttachment = ImageAttachment | ThreadMentionAttachment;

/** Max other threads the composer may attach to one send. */
export const MAX_THREAD_MENTIONS = 6;

export function isThreadMention(
  attachment: MessageAttachment,
): attachment is ThreadMentionAttachment {
  return attachment.type === 'thread';
}

export function isImageAttachment(
  attachment: MessageAttachment,
): attachment is ImageAttachment {
  return attachment.type !== 'thread';
}

export function imageAttachments(
  list: MessageAttachment[] | undefined,
): ImageAttachment[] {
  return (list ?? []).filter(isImageAttachment);
}

export function threadMentions(
  list: MessageAttachment[] | undefined,
): ThreadMentionAttachment[] {
  return (list ?? []).filter(isThreadMention);
}

export interface Message {
  id: string;
  threadId: string;
  runId: string | null;
  role: MessageRole;
  content: string;
  /** Image and/or thread-mention attachments on user messages. */
  attachments?: MessageAttachment[];
  /** Present only on assistant messages that requested tool calls. */
  toolCalls?: PendingToolCall[];
  /** Present only on tool-role messages, linking back to the assistant tool call. */
  toolCallId?: string;
  status: MessageStatus;
  createdAt: string;
  /** Wall-clock model-call + stream time for assistant messages; undefined for user/tool and old ledger replays. */
  durationMs?: number;
}

/**
 * A tool call reconstructed from the model's response.
 *
 * Assembled fragment-by-fragment from streamed chunk deltas.
 */
export interface PendingToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}
