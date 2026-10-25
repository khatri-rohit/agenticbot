import type { ChatMessage, ChatContentPart } from './run.js';
import type {
  Message,
  MessageAttachment,
  PendingToolCall,
} from './message.js';
import { isImageAttachment } from './message.js';

/**
 * One durable turn for the thread ledger.
 *
 * Folding a sequence of LedgerRecords (in order) must deep-equal the loop's
 * `messages` array before any compaction. Host appends only; memory/context
 * layers are read-only consumers.
 */
export type LedgerRecord =
  | LedgerSystemRecord
  | LedgerUserRecord
  | LedgerAssistantRecord
  | LedgerToolRecord;

/** Host-assigned metadata passed alongside a ledger record on append. */
export type LedgerAppendMeta = {
  /** Assistant response wall-clock duration (model-call + stream time). */
  durationMs?: number;
};

export type LedgerSystemRecord = {
  role: 'system';
  content: string;
};

export type LedgerUserRecord = {
  role: 'user';
  content: string;
};

export type LedgerAssistantRecord = {
  role: 'assistant';
  content: string | null;
  /** Present when the assistant requested tools; required for wire-accurate replay. */
  tool_calls?: PendingToolCall[];
};

export type LedgerToolRecord = {
  role: 'tool';
  tool_call_id: string;
  content: string;
};

/**
 * Host tape line. `record` is the loop message; seq/ts/ids are assigned by
 * the sole writer in apps/api. Folding `record`s in seq order must match
 * the loop's messages (minus the live system prompt).
 */
export type LedgerEnvelope = {
  v: 1;
  seq: number;
  ts: string;
  threadId: string;
  runId: string | null;
  record: LedgerRecord;
  /** sha256 hex when tool/user payload was offloaded to blobs/. */
  contentBlob?: string;
  /** User image attachments (not part of the Chat Completions record). */
  attachments?: MessageAttachment[];
  /** Assistant response wall-clock duration (model-call + stream); host-assigned like seq/ts. */
  durationMs?: number;
  /** User-requested skill names for the run that consumed this user turn. */
  skills?: { selected: string[] };
};

/** Skip system rows; they are rebuilt by the host each run. */
export function envelopeToChatMessage(
  envelope: LedgerEnvelope,
  toolContent = envelope.record.role === 'tool' ? envelope.record.content : '',
): ChatMessage | null {
  const { record, attachments } = envelope;
  if (record.role === 'system') return null;
  if (record.role === 'user') {
    if (attachments && attachments.length > 0) {
      const parts: ChatContentPart[] = [];
      const trimmed = record.content.trim();
      if (trimmed) parts.push({ type: 'text', text: trimmed });
      for (const attachment of attachments) {
        if (!isImageAttachment(attachment)) continue;
        parts.push({
          type: 'image_url',
          image_url: { url: attachment.dataUrl },
        });
      }
      if (parts.some((part) => part.type === 'image_url')) {
        return { role: 'user', content: parts };
      }
    }
    return { role: 'user', content: record.content };
  }
  if (record.role === 'assistant') {
    return {
      role: 'assistant',
      content: record.content,
      ...(record.tool_calls && record.tool_calls.length > 0
        ? { tool_calls: record.tool_calls }
        : {}),
    };
  }
  return {
    role: 'tool',
    tool_call_id: record.tool_call_id,
    content: toolContent,
  };
}

export function envelopeToUiMessage(
  envelope: LedgerEnvelope,
  toolContent = envelope.record.role === 'tool' ? envelope.record.content : '',
): Message | null {
  const chat = envelopeToChatMessage(envelope, toolContent);
  if (!chat || chat.role === 'system') return null;

  const id = `msg_${envelope.threadId}_${envelope.seq}`;
  if (chat.role === 'user') {
    const text =
      typeof chat.content === 'string'
        ? chat.content
        : chat.content
            .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
            .map((part) => part.text)
            .join('\n');
    return {
      id,
      threadId: envelope.threadId,
      runId: envelope.runId,
      role: 'user',
      content: text,
      ...(envelope.attachments?.length
        ? { attachments: envelope.attachments }
        : {}),
      status: 'complete',
      createdAt: envelope.ts,
    };
  }
  if (chat.role === 'assistant') {
    return {
      id,
      threadId: envelope.threadId,
      runId: envelope.runId,
      role: 'assistant',
      content: chat.content ?? '',
      ...(chat.tool_calls?.length ? { toolCalls: chat.tool_calls } : {}),
      status: 'complete',
      createdAt: envelope.ts,
      ...(envelope.durationMs != null
        ? { durationMs: envelope.durationMs }
        : {}),
    };
  }
  return {
    id,
    threadId: envelope.threadId,
    runId: envelope.runId,
    role: 'tool',
    content: chat.content,
    toolCallId: chat.tool_call_id,
    status: 'complete',
    createdAt: envelope.ts,
  };
}
