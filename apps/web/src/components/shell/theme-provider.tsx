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
  DEFAULT_THEME_PREFERENCE,
  type ThemePreference,
  type ThemeScheme,
  applyThemeToDocument,
  persistThemePreference,
  readStoredPreference,
  schemeForPreference,
} from '@/components/shell/theme-presets';

type ThemeContextValue = {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
  /** Resolved mode — what actually renders. */
  scheme: ThemeScheme;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // null until storage is read on mount. The inline init script has already
  // painted the right mode; applying a guessed default first would flicker.
  const [preference, setPreferenceState] = useState<ThemePreference | null>(
    null,
  );
  const [systemPrefersDark, setSystemPrefersDark] = useState(true);

  useEffect(() => {
    const media = window.matchMedia(SYSTEM_DARK_QUERY);
    setSystemPrefersDark(media.matches);
    setPreferenceState(readStoredPreference());
    const onChange = (event: MediaQueryListEvent) => {
      setSystemPrefersDark(event.matches);
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  // OS changes only move the scheme while the preference is System.
  const scheme: ThemeScheme = preference
    ? schemeForPreference(preference, systemPrefersDark)
    : 'dark';

  useEffect(() => {
    if (preference) applyThemeToDocument(scheme);
  }, [preference, scheme]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    persistThemePreference(next);
  }, []);

  const value = useMemo(
    () => ({
      preference: preference ?? DEFAULT_THEME_PREFERENCE,
      setPreference,
      scheme,
    }),
    [preference, setPreference, scheme],
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
