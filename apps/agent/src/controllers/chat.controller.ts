import { Request, Response } from 'express';
import { graph } from '../graph/v1/chatpipline';
import { pumpGraphChatToSse } from '../streaming/pump-graph-to-sse';
import { beginSseResponse, SseWriter } from '../streaming/sse-writer';

type ChatRequestBody = {
  prompt?: string;
  streamReasoning?: boolean;
};

/**
 * POST /api/v1/chat
 *
 * Flow:
 * 1. Validate JSON body
 * 2. Open SSE on the HTTP response (`streaming/sse-writer`)
 * 3. Stream LangGraph message chunks → SSE events (`streaming/pump-graph-to-sse`)
 */
export const chatController = async (req: Request, res: Response) => {
  const { prompt, streamReasoning } = req.body as ChatRequestBody;

  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({ error: 'prompt is required' });
    return;
  }

  beginSseResponse(res);
  const sse = new SseWriter(req, res);

  try {
    await pumpGraphChatToSse(graph, sse, {
      prompt,
      includeReasoning: streamReasoning === true,
    });
  } catch (error) {
    console.error('chat stream error', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Stream failed' });
      return;
    }
    if (sse.isClientConnected) {
      sse.send({ type: 'error', message: 'Stream failed' });
      sse.close();
    }
  }
};
