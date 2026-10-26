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

/**
 * Validate then normalize a thread kind from untrusted input (request body).
 * Returns undefined for values outside the accept-list, so callers can skip
 * the field instead of defaulting unknown input to home.
 */
export function parseThreadKind(value: unknown): ThreadKind | undefined {
  if (
    value === 'home' ||
    value === 'workspace' ||
    value === 'research' ||
    value === 'coding'
  ) {
    return normalizeThreadKind(value);
  }
  return undefined;
}

export function isWorkspaceKind(kind: ThreadKind | undefined): boolean {
  return kind === 'workspace';
}

/** Strip trailing slashes and unify separators. Display form, not a compare key. */
export function normalizeWorkspaceRoot(root: string): string {
  return root.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/');
}

/** Case-insensitive identity for grouping and memory files. */
export function workspaceRootKey(root: string): string {
  return normalizeWorkspaceRoot(root).toLowerCase();
}

export function sameWorkspaceRoot(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return false;
  return workspaceRootKey(left) === workspaceRootKey(right);
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
