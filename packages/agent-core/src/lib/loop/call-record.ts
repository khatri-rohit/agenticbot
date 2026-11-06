import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { TraceCallInput, TraceMessageRef } from '@agent/agent-models';

import type { ModelTurn } from '../model/types';
import { sha256Text } from '../tools/web/source';
import type { ToolRegistry } from '../tools/types';

export type CallRecorder = {
  /** Refs for exactly what this call sends; call it before the call (the loop replaces slots later). */
  input(messages: ChatCompletionMessageParam[], tools: ToolRegistry): TraceCallInput;
  /** Ref for the assistant message a call returned. */
  output(turn: ModelTurn): { sha: string };
};

/** Image data is already in the ledger's attachments; a recording keeps only its size. */
function withoutImageData(message: ChatCompletionMessageParam): unknown {
  if (!Array.isArray(message.content)) return message;
  return {
    ...message,
    content: message.content.map((part) =>
      part.type === 'image_url' ? { type: 'text', text: `[image ${part.image_url.url.length} chars]` } : part,
    ),
  };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part: { type?: string; text?: string }) => (part.type === 'text' ? (part.text ?? '') : '')).join('');
  }
  return '';
}

/**
 * Records every model call's input and output as content-addressed blobs
 * (`JSON.stringify(message)` keyed by its sha256, the same key the host
 * blob store uses), so a viewer can rebuild what was sent, image data aside. Each
 * text is written once per run; a failed write never affects the run.
 */
export function createCallRecorder(putBlob: (text: string) => Promise<string>): CallRecorder {
  const written = new Set<string>();
  const store = (text: string): string => {
    const sha = sha256Text(text);
    if (!written.has(sha)) {
      written.add(sha);
      // Recording is best-effort: a lost blob shows as "not recorded", the run goes on.
      putBlob(text).catch(() => written.delete(sha));
    }
    return sha;
  };

  return {
    input(messages, tools) {
      const refs: TraceMessageRef[] = messages.map((message) => {
        const ref: TraceMessageRef = {
          role: message.role,
          sha: store(JSON.stringify(withoutImageData(message))),
          chars: textOf(message.content).length,
        };
        if (message.role === 'tool') ref.toolCallId = message.tool_call_id;
        if (message.role === 'assistant' && message.tool_calls?.length) {
          ref.toolCallIds = message.tool_calls.map((call) => call.id);
        }
        return ref;
      });
      return {
        messages: refs,
        tools:
          tools.definitions.length > 0
            ? {
                sha: store(JSON.stringify(tools.definitions)),
                names: tools.definitions.map((definition) =>
                  definition.type === 'function' ? definition.function.name : definition.type,
                ),
              }
            : null,
      };
    },
    output(turn) {
      const message = {
        role: 'assistant',
        content: turn.content || null,
        ...(turn.toolCalls.length > 0 ? { tool_calls: turn.toolCalls } : {}),
      };
      return { sha: store(JSON.stringify(message)) };
    },
  };
}
