export const THEME_STORAGE_KEY = 'desk-ui-theme';

/** What the user picks in settings. */
export type ThemePreference = 'light' | 'dark' | 'system';

/** What actually renders — resolved from the preference. */
export type ThemeScheme = 'light' | 'dark';

export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system';

export const THEME_PREFERENCES: ThemePreference[] = [
  'light',
  'dark',
  'system',
];

export function isThemePreference(value: string): value is ThemePreference {
  return THEME_PREFERENCES.some((preference) => preference === value);
}

/**
 * Legacy ids from the preset era (and earlier reading themes) → mode.
 * Dark presets (studio/midnight/ember) keep dark; paper was the light one.
 */
const LEGACY_THEME_MAP: Record<string, ThemeScheme> = {
  studio: 'dark',
  midnight: 'dark',
  ember: 'dark',
  paper: 'light',
  ink: 'dark',
  signal: 'dark',
  glacier: 'dark',
  moss: 'dark',
  lamp: 'dark',
};

export function resolveStoredPreference(
  raw: string | null | undefined,
): ThemePreference {
  if (!raw) return DEFAULT_THEME_PREFERENCE;
  if (isThemePreference(raw)) return raw;
  const scheme = LEGACY_THEME_MAP[raw];
  return scheme ?? DEFAULT_THEME_PREFERENCE;
}

export function schemeForPreference(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ThemeScheme {
  if (preference === 'system') {
    return systemPrefersDark ? 'dark' : 'light';
  }
  return preference;
}

export function applyThemeToDocument(scheme: ThemeScheme): void {
  const root = document.documentElement;
  root.classList.toggle('dark', scheme === 'dark');
  root.classList.toggle('light', scheme === 'light');
  root.style.colorScheme = scheme;
}

export function readStoredPreference(): ThemePreference {
  if (typeof window === 'undefined') return DEFAULT_THEME_PREFERENCE;
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    const resolved = resolveStoredPreference(raw);
    if (raw && raw !== resolved) persistThemePreference(resolved);
    return resolved;
  } catch {
    return DEFAULT_THEME_PREFERENCE;
  }
}

export function persistThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    /* storage blocked */
  }
}

/**
 * FOUC guard, run before paint. Must stay an inline string — an imported
 * module would execute after first paint. Built from the same constants the
 * provider uses, so the two cannot drift.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var k=${JSON.stringify(THEME_STORAGE_KEY)};var d=${JSON.stringify(DEFAULT_THEME_PREFERENCE)};var legacy=${JSON.stringify(LEGACY_THEME_MAP)};var prefs=${JSON.stringify(THEME_PREFERENCES)};var t=localStorage.getItem(k)||d;if(legacy[t])t=legacy[t];if(prefs.indexOf(t)<0)t=d;var sys=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches;var dark=t==='dark'||(t==='system'&&sys);document.documentElement.classList.toggle('dark',dark);document.documentElement.classList.toggle('light',!dark);document.documentElement.style.colorScheme=dark?'dark':'light';}catch(e){document.documentElement.classList.add('dark');document.documentElement.style.colorScheme='dark';}})();`;
