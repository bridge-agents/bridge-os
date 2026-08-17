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
export type AccentPreset = "metallic" | "blue" | "violet" | "amber" | "custom";

interface ThemeValue {
  preference: ThemePreference;
  appearance: Appearance;
  accent: AccentPreset;
  customAccent: string;
  setPreference: (next: ThemePreference) => void;
  setAccent: (next: AccentPreset) => void;
  setCustomAccent: (next: string) => void;
  /** Flip to the opposite of what is currently on screen. */
  toggle: () => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);
const STORAGE_KEY = "bridge:theme";
const ACCENT_KEY = "bridge:accent";
const CUSTOM_ACCENT_KEY = "bridge:accent-custom";
const VALID_ACCENTS = new Set<AccentPreset>(["metallic", "blue", "violet", "amber", "custom"]);

const systemAppearance = (): Appearance =>
  window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setStoredPreference] = useState<ThemePreference>(
    () => (localStorage.getItem(STORAGE_KEY) as ThemePreference | null) ?? "system",
  );
  const [system, setSystem] = useState<Appearance>(systemAppearance);
  const [accent, setStoredAccent] = useState<AccentPreset>(() => {
    const stored = localStorage.getItem(ACCENT_KEY) as AccentPreset | null;
    return stored && VALID_ACCENTS.has(stored) ? stored : "metallic";
  });
  const [customAccent, setStoredCustomAccent] = useState(
    () => localStorage.getItem(CUSTOM_ACCENT_KEY) ?? "#2563eb",
  );

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
    document.documentElement.classList.toggle("dark", appearance === "dark");
  }, [appearance]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.accent = accent;
    const properties = [
      "--primary",
      "--primary-foreground",
      "--ring",
      "--accent",
      "--accent-foreground",
      "--sidebar-primary",
      "--sidebar-primary-foreground",
      "--sidebar-ring",
    ];
    for (const property of properties) root.style.removeProperty(property);
    if (accent !== "custom" || !/^#[0-9a-f]{6}$/i.test(customAccent)) return;
    const foreground = contrastForeground(customAccent);
    root.style.setProperty("--primary", customAccent);
    root.style.setProperty("--primary-foreground", foreground);
    root.style.setProperty("--ring", customAccent);
    root.style.setProperty(
      "--accent",
      `color-mix(in oklab, ${customAccent} 14%, var(--background))`,
    );
    root.style.setProperty("--accent-foreground", customAccent);
    root.style.setProperty("--sidebar-primary", customAccent);
    root.style.setProperty("--sidebar-primary-foreground", foreground);
    root.style.setProperty("--sidebar-ring", customAccent);
  }, [accent, customAccent]);

  const setPreference = useCallback((next: ThemePreference) => {
    setStoredPreference(next);
    if (next === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  }, []);

  const toggle = useCallback(
    () => setPreference(appearance === "dark" ? "light" : "dark"),
    [appearance, setPreference],
  );

  const setAccent = useCallback((next: AccentPreset) => {
    setStoredAccent(next);
    localStorage.setItem(ACCENT_KEY, next);
  }, []);

  const setCustomAccent = useCallback((next: string) => {
    setStoredCustomAccent(next);
    localStorage.setItem(CUSTOM_ACCENT_KEY, next);
    setStoredAccent("custom");
    localStorage.setItem(ACCENT_KEY, "custom");
  }, []);

  const value = useMemo<ThemeValue>(
    () => ({
      preference,
      appearance,
      accent,
      customAccent,
      setPreference,
      setAccent,
      setCustomAccent,
      toggle,
    }),
    [
      preference,
      appearance,
      accent,
      customAccent,
      setPreference,
      setAccent,
      setCustomAccent,
      toggle,
    ],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

function contrastForeground(hex: string): "#ffffff" | "#09090b" {
  const value = Number.parseInt(hex.slice(1), 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return red * 0.299 + green * 0.587 + blue * 0.114 > 155 ? "#09090b" : "#ffffff";
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}
