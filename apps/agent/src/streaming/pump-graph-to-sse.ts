import type { ChatPipeline } from '../graph/v1/chatpipline';
import { CHATBOT_NODE_ID } from '../graph/v1/chatpipline';
import type { ChatSseEvent } from './chat-sse-protocol';
import { partsFromLangGraphMessageChunk } from './langgraph-message-parts';
import type { SseWriter } from './sse-writer';

export type PumpChatStreamOptions = {
  prompt: string;
  /** When false, reasoning chunks from the model are dropped (not sent over SSE). */
  includeReasoning: boolean;
};

function partToSseEvent(part: {
  kind: 'answer' | 'reasoning';
  text: string;
}): ChatSseEvent {
  return part.kind === 'reasoning'
    ? { type: 'reasoning', content: part.text }
    : { type: 'token', content: part.text };
}

/**
 * Runs the LangGraph chat pipeline and forwards only the chatbot node's message
 * stream to the client as SSE events.
 */
export async function pumpGraphChatToSse(
  graph: ChatPipeline,
  sse: SseWriter,
  options: PumpChatStreamOptions,
): Promise<void> {
  const stream = await graph.stream(
    { messages: [{ role: 'user', content: options.prompt }] },
    { streamMode: 'messages' },
  );

  for await (const chunk of stream) {
    if (!sse.isClientConnected) break;

    const [message, metadata] = chunk as [unknown, { langgraph_node?: string }];

    if (metadata?.langgraph_node !== CHATBOT_NODE_ID) continue;

    for (const part of partsFromLangGraphMessageChunk(message)) {
      if (part.kind === 'reasoning' && !options.includeReasoning) continue;
      sse.send(partToSseEvent(part));
    }
  }

  if (sse.isClientConnected) {
    sse.send({ type: 'done' });
    sse.close();
  }
}
