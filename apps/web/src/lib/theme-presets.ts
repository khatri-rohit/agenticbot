export const THEME_STORAGE_KEY = 'agenticbot-ui-theme';

export type ThemeId =
  | 'cursor'
  | 'neutral'
  | 'vscode'
  | 'material'
  | 'midnight'
  | 'ember'
  | 'copper'
  | 'forest'
  | 'ocean';

export type ThemePreset = {
  id: ThemeId;
  label: string;
  description: string;
  /** Preview chips for the theme picker */
  swatch: { bg: string; accent: string };
};

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'cursor',
    label: 'Cursor Dark',
    description: 'Cool neutral, flat IDE feel',
    swatch: { bg: 'oklch(0.1 0.006 264)', accent: 'oklch(0.7 0.09 238)' },
  },
  {
    id: 'neutral',
    label: 'Classic Dark',
    description: 'Balanced zinc, minimal tint',
    swatch: { bg: 'oklch(0.11 0.004 286)', accent: 'oklch(0.75 0.04 286)' },
  },
  {
    id: 'vscode',
    label: 'VS Code Dark',
    description: 'Blue-gray editor chrome',
    swatch: { bg: 'oklch(0.12 0.02 255)', accent: 'oklch(0.62 0.14 250)' },
  },
  {
    id: 'material',
    label: 'Material Dark',
    description: 'M3-style violet surfaces',
    swatch: { bg: 'oklch(0.11 0.02 300)', accent: 'oklch(0.72 0.12 295)' },
  },
  {
    id: 'midnight',
    label: 'Midnight',
    description: 'Deep blue night',
    swatch: { bg: 'oklch(0.09 0.03 265)', accent: 'oklch(0.68 0.12 255)' },
  },
  {
    id: 'ember',
    label: 'Ember',
    description: 'Dark wine and rose hints',
    swatch: { bg: 'oklch(0.1 0.025 20)', accent: 'oklch(0.68 0.14 18)' },
  },
  {
    id: 'copper',
    label: 'Copper',
    description: 'Warm charcoal and amber',
    swatch: { bg: 'oklch(0.105 0.022 55)', accent: 'oklch(0.72 0.13 55)' },
  },
  {
    id: 'forest',
    label: 'Forest',
    description: 'Muted green undertone',
    swatch: { bg: 'oklch(0.1 0.02 155)', accent: 'oklch(0.7 0.11 155)' },
  },
  {
    id: 'ocean',
    label: 'Ocean',
    description: 'Teal depth, calm contrast',
    swatch: { bg: 'oklch(0.1 0.022 200)', accent: 'oklch(0.72 0.1 195)' },
  },
];

export const DEFAULT_THEME_ID: ThemeId = 'cursor';

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
