import type { Request, Response } from 'express';
import type { ChatSseEvent } from './chat-sse-protocol';

function flushResponse(res: Response) {
  const maybeFlush = res as Response & { flush?: () => void };
  maybeFlush.flush?.();
  res.socket?.uncork?.();
}

/** Configures response headers and sends the SSE comment that opens the stream. */
export function beginSseResponse(res: Response): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write(': connected\n\n');
  flushResponse(res);
}

/**
 * Tracks client disconnect and writes SSE `data:` frames.
 * Stops writing once the client is gone (aborted request or closed socket).
 */
export class SseWriter {
  private clientDisconnected = false;

  constructor(
    req: Request,
    private readonly res: Response,
  ) {
    req.on('aborted', () => {
      this.clientDisconnected = true;
    });
    res.on('close', () => {
      if (!res.writableEnded) this.clientDisconnected = true;
    });
  }

  get isClientConnected(): boolean {
    return !this.clientDisconnected;
  }

  send(event: ChatSseEvent): void {
    if (this.clientDisconnected) return;
    this.res.write(`data: ${JSON.stringify(event)}\n\n`);
    flushResponse(this.res);
  }

  close(): void {
    if (this.clientDisconnected || this.res.writableEnded) return;
    this.res.end();
  }
}
