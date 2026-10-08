/**
 * A conversation thread. The top-level durable entity.
 *
 * Owned by the client (IndexedDB). The server is stateless and does not
 * persist threads — it receives full message context per run.
 */
export const CHAT_TITLE_MIN_WORDS = 5;
export const CHAT_TITLE_MAX_WORDS = 7;

/** Keep titles short for sidebar and header; enforces a max word count. */
export function clampChatTitle(title: string, fallback = 'New Chat'): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return fallback;
  return words.slice(0, CHAT_TITLE_MAX_WORDS).join(' ');
}

export interface Thread {
  id: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  /** Pinned threads stay at the top of the sidebar (by updatedAt among pins). */
  pinned?: boolean;
}
