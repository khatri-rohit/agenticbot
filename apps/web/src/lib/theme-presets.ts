export const THEME_STORAGE_KEY = 'agenticbot-ui-theme';

export type ThemeId = 'studio' | 'midnight' | 'ember' | 'paper';

export type ThemeScheme = 'dark' | 'light';

export type ThemePreset = {
  id: ThemeId;
  label: string;
  description: string;
  scheme: ThemeScheme;
  /** Preview chips for the theme picker */
  swatch: { bg: string; accent: string };
};

/** Legacy ids from earlier reading-theme set → current presets. */
const LEGACY_THEME_MAP: Record<string, ThemeId> = {
  ink: 'studio',
  signal: 'studio',
  glacier: 'midnight',
  moss: 'midnight',
  lamp: 'ember',
};

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'studio',
    label: 'Studio',
    description: 'Near-black IDE chrome — default',
    scheme: 'dark',
    swatch: { bg: 'oklch(0.14 0.004 250)', accent: 'oklch(0.7 0.1 195)' },
  },
  {
    id: 'midnight',
    label: 'Midnight',
    description: 'Cool blue-slate dark',
    scheme: 'dark',
    swatch: { bg: 'oklch(0.14 0.018 250)', accent: 'oklch(0.68 0.13 250)' },
  },
  {
    id: 'ember',
    label: 'Ember',
    description: 'Warm charcoal for evening work',
    scheme: 'dark',
    swatch: { bg: 'oklch(0.14 0.018 55)', accent: 'oklch(0.74 0.12 55)' },
  },
  {
    id: 'paper',
    label: 'Paper',
    description: 'Clean light workbench',
    scheme: 'light',
    swatch: { bg: 'oklch(0.985 0.004 250)', accent: 'oklch(0.45 0.12 230)' },
  },
];

export const DEFAULT_THEME_ID: ThemeId = 'studio';

export const THEME_IDS: ThemeId[] = THEME_PRESETS.map((p) => p.id);

export function isThemeId(value: string): value is ThemeId {
  return THEME_PRESETS.some((p) => p.id === value);
}

export function resolveThemeId(value: string | null | undefined): ThemeId {
  if (!value) return DEFAULT_THEME_ID;
  if (isThemeId(value)) return value;
  return LEGACY_THEME_MAP[value] ?? DEFAULT_THEME_ID;
}

export function themeScheme(themeId: ThemeId): ThemeScheme {
  return THEME_PRESETS.find((p) => p.id === themeId)?.scheme ?? 'dark';
}

export function applyThemeToDocument(themeId: ThemeId): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', themeId);
  const scheme = themeScheme(themeId);
  root.classList.toggle('dark', scheme === 'dark');
  root.classList.toggle('light', scheme === 'light');
  root.style.colorScheme = scheme;
}

export function readStoredThemeId(): ThemeId {
  if (typeof window === 'undefined') return DEFAULT_THEME_ID;
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    const resolved = resolveThemeId(raw);
    if (raw && raw !== resolved) persistThemeId(resolved);
    return resolved;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

export function persistThemeId(themeId: ThemeId): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, themeId);
  } catch {
    /* storage blocked */
  }
}
