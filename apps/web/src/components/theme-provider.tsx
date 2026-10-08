'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  DEFAULT_THEME_ID,
  type ThemeId,
  THEME_PRESETS,
  applyThemeToDocument,
  persistThemeId,
  readStoredThemeId,
} from '@/lib/theme-presets';

type ThemeContextValue = {
  themeId: ThemeId;
  setThemeId: (id: ThemeId) => void;
  presets: typeof THEME_PRESETS;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themeId, setThemeIdState] = useState<ThemeId>(DEFAULT_THEME_ID);

  useEffect(() => {
    const stored = readStoredThemeId();
    setThemeIdState(stored);
    applyThemeToDocument(stored);
  }, []);

  const setThemeId = useCallback((id: ThemeId) => {
    setThemeIdState(id);
    applyThemeToDocument(id);
    persistThemeId(id);
  }, []);

  const value = useMemo(
    () => ({ themeId, setThemeId, presets: THEME_PRESETS }),
    [themeId, setThemeId],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return ctx;
}
