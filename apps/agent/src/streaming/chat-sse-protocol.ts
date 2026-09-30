/**
 * Wire format for POST /api/v1/chat (Server-Sent Events).
 * Each event is one JSON object in a `data:` line.
 */
export type ChatSseEvent =
  | { type: 'token'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'done' }
  | { type: 'error'; message: string };
