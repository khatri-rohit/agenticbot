/** Sidebar/header title limits (keep in sync with @org/agent-models). */
export const CHAT_TITLE_MAX_WORDS = 7;

export function clampChatTitle(title: string, fallback = 'New Chat'): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return fallback;
  return words.slice(0, CHAT_TITLE_MAX_WORDS).join(' ');
}
