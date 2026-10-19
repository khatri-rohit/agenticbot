/**
 * A conversation thread. The top-level durable entity.
 *
 * Owned by the API host catalog. The web UI is a client of /api/agent/threads.
 */
export const CHAT_TITLE_MIN_WORDS = 5;
export const CHAT_TITLE_MAX_WORDS = 7;

/** Keep titles short for sidebar and header; enforces a max word count. */
export function clampChatTitle(title: string, fallback = 'New Chat'): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return fallback;
  return words.slice(0, CHAT_TITLE_MAX_WORDS).join(' ');
}

/**
 * Binding, not a product mode. Home = no folder. Workspace = bound to a folder.
 * Legacy catalog values `research` / `coding` normalize to these.
 */
export type ThreadKind = 'home' | 'workspace';

/** Accept stored or client values, including pre-rename research/coding. */
export function normalizeThreadKind(value: unknown): ThreadKind {
  if (value === 'workspace' || value === 'coding') return 'workspace';
  return 'home';
}

export function isWorkspaceKind(kind: ThreadKind | undefined): boolean {
  return kind === 'workspace';
}

export interface Thread {
  id: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  /** Pinned threads stay at the top of the sidebar (by updatedAt among pins). */
  pinned?: boolean;
  /** Home vs workspace. Omitted/legacy rows normalize to home. */
  kind?: ThreadKind;
  /** Absolute workspace folder when kind is workspace. */
  workspaceRoot?: string;
}
