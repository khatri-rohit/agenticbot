export const THEME_STORAGE_KEY = 'agenticbot-ui-theme';

export type ThemeId = 'ink' | 'lamp' | 'glacier' | 'moss' | 'signal';

export type ThemePreset = {
  id: ThemeId;
  label: string;
  description: string;
  /** Preview chips for the theme picker */
  swatch: { bg: string; accent: string };
};

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'ink',
    label: 'Ink',
    description: 'Soft warm charcoal for long reads',
    swatch: { bg: 'oklch(0.14 0.012 70)', accent: 'oklch(0.72 0.06 70)' },
  },
  {
    id: 'lamp',
    label: 'Lamp',
    description: 'Amber reading-lamp warmth',
    swatch: { bg: 'oklch(0.13 0.03 65)', accent: 'oklch(0.78 0.12 65)' },
  },
  {
    id: 'glacier',
    label: 'Glacier',
    description: 'Cool blue-gray, crisp contrast',
    swatch: { bg: 'oklch(0.13 0.02 240)', accent: 'oklch(0.72 0.09 230)' },
  },
  {
    id: 'moss',
    label: 'Moss',
    description: 'Deep green study room',
    swatch: { bg: 'oklch(0.13 0.025 150)', accent: 'oklch(0.7 0.1 150)' },
  },
  {
    id: 'signal',
    label: 'Signal',
    description: 'Near-black with vivid block accents',
    swatch: { bg: 'oklch(0.1 0.01 280)', accent: 'oklch(0.75 0.18 145)' },
  },
];

export const DEFAULT_THEME_ID: ThemeId = 'ink';

export const THEME_IDS: ThemeId[] = THEME_PRESETS.map((p) => p.id);

export function isThemeId(value: string): value is ThemeId {
  return THEME_PRESETS.some((p) => p.id === value);
}

export function applyThemeToDocument(themeId: ThemeId): void {
  document.documentElement.setAttribute('data-theme', themeId);
  document.documentElement.classList.add('dark');
}

export function readStoredThemeId(): ThemeId {
  if (typeof window === 'undefined') return DEFAULT_THEME_ID;
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw && isThemeId(raw)) return raw;
  } catch {
    /* storage blocked */
  }
  return DEFAULT_THEME_ID;
}

export function persistThemeId(themeId: ThemeId): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, themeId);
  } catch {
    /* storage blocked */
  }
}
