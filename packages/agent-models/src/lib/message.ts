import type { ThreadKind } from './thread.js';
import type { ToolOutcome } from './tool-outcome.js';

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

/** Max images on one send. */
export const MAX_IMAGE_ATTACHMENTS = 20;

/** Max decoded image size (base64 inflates the wire size by ~4/3). */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export const IMAGE_MIME_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

export function approximateDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Math.ceil((base64.length * 3) / 4);
}

const THREAD_KINDS: readonly string[] = ['home', 'workspace'];

/**
 * Trust boundary for attachments arriving over HTTP. A bad image stays in the
 * ledger and is re-sent on every later run, so reject it instead of storing it.
 */
export function parseMessageAttachments(
  raw: unknown,
): MessageAttachment[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return 'attachments must be an array';
  const out: MessageAttachment[] = [];
  let images = 0;
  let mentions = 0;
  for (const item of raw) {
    if (!item || typeof item !== 'object') return 'invalid attachment';
    const a = item as Record<string, unknown>;
    if (a.type === 'thread') {
      if (
        typeof a.id !== 'string' ||
        typeof a.threadId !== 'string' ||
        typeof a.title !== 'string' ||
        typeof a.kind !== 'string' ||
        !THREAD_KINDS.includes(a.kind) ||
        (a.workspaceRoot !== undefined && typeof a.workspaceRoot !== 'string')
      ) {
        return 'invalid thread mention';
      }
      if (++mentions > MAX_THREAD_MENTIONS) {
        return `at most ${MAX_THREAD_MENTIONS} thread mentions per message`;
      }
      out.push(a as ThreadMentionAttachment);
      continue;
    }
    if (a.type !== undefined && a.type !== 'image') return 'invalid attachment';
    if (
      typeof a.id !== 'string' ||
      typeof a.mimeType !== 'string' ||
      typeof a.dataUrl !== 'string' ||
      (a.name !== undefined && typeof a.name !== 'string')
    ) {
      return 'invalid image attachment';
    }
    if (!IMAGE_MIME_TYPES.includes(a.mimeType)) {
      return 'Only PNG, JPEG, WebP, and GIF images are supported.';
    }
    if (!a.dataUrl.startsWith(`data:${a.mimeType};base64,`)) {
      return 'image dataUrl does not match its mimeType';
    }
    if (approximateDataUrlBytes(a.dataUrl) > MAX_IMAGE_BYTES) {
      return 'Image is too large (max 4 MB).';
    }
    if (++images > MAX_IMAGE_ATTACHMENTS) {
      return `at most ${MAX_IMAGE_ATTACHMENTS} images per message`;
    }
    out.push(a as ImageAttachment);
  }
  return out;
}

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
  /** Present only on tool-role messages. */
  toolOutcome?: ToolOutcome;
  status: MessageStatus;
  createdAt: string;
  /** Wall-clock model-call + stream time for assistant messages; undefined for user/tool and old ledger replays. */
  durationMs?: number;
  /** On a run's final answer: wall clock of the whole run (all calls, tools, sub-agents). */
  runDurationMs?: number;
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
