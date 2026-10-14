const USER_PERSONA_STORAGE_KEY = 'agenticbot-user-persona';

/** Matches API truncation on POST /api/agent/run. */
export const USER_PERSONA_MAX_CHARS = 2000;

export function getUserPersona(): string {
  if (typeof window === 'undefined') return '';
  try {
    return localStorage.getItem(USER_PERSONA_STORAGE_KEY)?.trim() ?? '';
  } catch {
    return '';
  }
}

export function setUserPersona(value: string): void {
  const trimmed = value.trim().slice(0, USER_PERSONA_MAX_CHARS);
  try {
    if (!trimmed) {
      localStorage.removeItem(USER_PERSONA_STORAGE_KEY);
      return;
    }
    localStorage.setItem(USER_PERSONA_STORAGE_KEY, trimmed);
  } catch {
    /* storage blocked */
  }
}
