import { Request, Response } from 'express';
import { graph } from '../graph/v1/chatpipline';

type StreamPart = { kind: 'answer' | 'reasoning'; text: string };

function extractStreamParts(msg: unknown): StreamPart[] {
  if (!msg || typeof msg !== 'object') return [];
  const m = msg as Record<string, unknown>;
  const parts: StreamPart[] = [];

  const kwargs = m.additional_kwargs;
  if (kwargs && typeof kwargs === 'object') {
    const reasoning = (kwargs as Record<string, unknown>).reasoning_content;
    if (typeof reasoning === 'string' && reasoning) {
      parts.push({ kind: 'reasoning', text: reasoning });
    }
  }

  let answer = '';
  if (typeof m.text === 'string' && m.text) {
    answer = m.text;
  } else if (typeof m.content === 'string' && m.content) {
    answer = m.content;
  } else if (Array.isArray(m.contentBlocks)) {
    answer = m.contentBlocks
      .map((block) => {
        if (!block || typeof block !== 'object') return '';
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') return b.text;
        return '';
      })
      .join('');
  }

  if (answer) parts.push({ kind: 'answer', text: answer });
  return parts;
}

function flushResponse(res: Response) {
  const maybeFlush = res as Response & { flush?: () => void };
  maybeFlush.flush?.();
  res.socket?.uncork?.();
}

function writeSse(res: Response, payload: Record<string, unknown>) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  flushResponse(res);
}

/** POST /chat — streams LLM tokens as Server-Sent Events (SSE). */
export const chatController = async (req: Request, res: Response) => {
  const { prompt, streamReasoning } = req.body as {
    prompt?: string;
    streamReasoning?: boolean;
  };

  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({ error: 'prompt is required' });
    return;
  }

  const includeReasoning = streamReasoning === true;

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // Opens the stream immediately so clients (and proxies) don't wait for the first token.
  res.write(': connected\n\n');
  flushResponse(res);

  let clientGone = false;
  req.on('aborted', () => {
    clientGone = true;
  });
  res.on('close', () => {
    if (!res.writableEnded) clientGone = true;
  });

  try {
    const stream = await graph.stream(
      { messages: [{ role: 'user', content: prompt }] },
      { streamMode: 'messages' },
    );

    for await (const chunk of stream) {
      if (clientGone) break;

      const [msg, metadata] = chunk as [unknown, { langgraph_node?: string }];

      if (metadata?.langgraph_node !== 'chatbot') continue;

      for (const part of extractStreamParts(msg)) {
        if (part.kind === 'reasoning' && !includeReasoning) continue;
        console.log('part', part);
        writeSse(res, {
          type: part.kind === 'reasoning' ? 'reasoning' : 'token',
          content: part.text,
        });
      }
    }

    if (!clientGone) {
      writeSse(res, { type: 'done' });
      res.end();
    }
  } catch (error) {
    console.error('chat stream error', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Stream failed' });
      return;
    }
    writeSse(res, { type: 'error', message: 'Stream failed' });
    res.end();
  }
};
