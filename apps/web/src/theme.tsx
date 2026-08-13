import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

/**
 * Appearance. Three states, not two: "system" is the default, so Bridge
 * follows the OS until someone actually expresses a preference — and keeps
 * following it as the OS changes through the day.
 *
 * The theme is applied as `data-theme` on <html>; every colour comes from
 * tokens (ADR-0006), so nothing else in the app is theme-aware.
 */
export type ThemePreference = "system" | "light" | "dark";
export type Appearance = "light" | "dark";

interface ThemeValue {
  preference: ThemePreference;
  appearance: Appearance;
  setPreference: (next: ThemePreference) => void;
  /** Flip to the opposite of what is currently on screen. */
  toggle: () => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);
const STORAGE_KEY = "bridge:theme";

const systemAppearance = (): Appearance =>
  window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setStoredPreference] = useState<ThemePreference>(
    () => (localStorage.getItem(STORAGE_KEY) as ThemePreference | null) ?? "system",
  );
  const [system, setSystem] = useState<Appearance>(systemAppearance);

  // Follow the OS while the preference is "system", including live changes.
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => setSystem(query.matches ? "light" : "dark");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const appearance: Appearance = preference === "system" ? system : preference;

  useEffect(() => {
    document.documentElement.dataset.theme = appearance;
  }, [appearance]);

  const setPreference = useCallback((next: ThemePreference) => {
    setStoredPreference(next);
    if (next === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  }, []);

  const toggle = useCallback(
    () => setPreference(appearance === "dark" ? "light" : "dark"),
    [appearance, setPreference],
  );

  const value = useMemo<ThemeValue>(
    () => ({ preference, appearance, setPreference, toggle }),
    [preference, appearance, setPreference, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}
