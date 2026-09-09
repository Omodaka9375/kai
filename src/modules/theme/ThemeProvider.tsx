import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  loadPreferences,
  onPreferencesChange,
  setTheme as persistTheme,
  setUiThemeId as persistUiTheme,
  type ThemePref,
} from "@/modules/settings/store";
import { applyUiTheme } from "./palettes";

export type Theme = ThemePref;

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: Theme;
};

type ThemeProviderState = {
  theme: Theme;
  resolvedTheme: "dark" | "light";
  setTheme: (theme: Theme) => void;
  uiThemeId: string;
  setUiThemeId: (id: string) => void;
};

const ThemeProviderContext = createContext<ThemeProviderState | null>(null);

export function ThemeProvider({
  children,
  defaultTheme = "system",
}: ThemeProviderProps) {
  // Initial paint uses the defaults; the persistent preference (in
  // tauri-plugin-store) hydrates on mount via the effect below. We no longer
  // mirror to localStorage: the per-PID WebView2 profile wipes it every
  // launch, so it only ever helped in-session reloads — not worth the code.
  const [theme, setThemeState] = useState<Theme>(defaultTheme);
  const [uiThemeId, setUiThemeIdState] = useState<string>("default");
  const [systemDark, setSystemDark] = useState<boolean>(() =>
    typeof window === "undefined"
      ? true
      : window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  // Track the last-applied (uiThemeId, mode) pair so we can skip
  // redundant applyUiTheme calls when only one of the two changes in a
  // way that doesn't affect the output (e.g. system dark-mode toggle
  // while on a palette that only has dark vars).
  const lastAppliedRef = useRef<{ id: string; mode: "light" | "dark" } | null>(null);

  // Hydrate from the persistent store (cross-window source of truth).
  useEffect(() => {
    let alive = true;
    void loadPreferences().then((p) => {
      if (!alive) return;
      setThemeState(p.theme);
      setUiThemeIdState(p.uiThemeId);
    });
    const unlistenP = onPreferencesChange((key, value) => {
      // Guard: skip if the value matches current state — prevents the
      // window that originated the change from re-applying its own write.
      if (key === "theme" && (value === "system" || value === "light" || value === "dark")) {
        setThemeState((prev) => (prev === value ? prev : value));
      }
      if (key === "uiThemeId" && typeof value === "string") {
        setUiThemeIdState((prev) => (prev === value ? prev : value));
      }
    });
    return () => {
      alive = false;
      void unlistenP.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const resolvedTheme: "dark" | "light" =
    theme === "system" ? (systemDark ? "dark" : "light") : theme;

  useEffect(() => {
    // Skip if the (id, mode) pair hasn't changed — avoids wasted
    // teardown/rebuild cycles on system dark-mode toggles, hydration
    // re-renders, or cross-window event echoes.
    const prev = lastAppliedRef.current;
    if (prev && prev.id === uiThemeId && prev.mode === resolvedTheme) return;
    lastAppliedRef.current = { id: uiThemeId, mode: resolvedTheme };

    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(resolvedTheme);
    applyUiTheme(uiThemeId, resolvedTheme);
  }, [resolvedTheme, uiThemeId]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    void persistTheme(next);
  }, []);

  const setUiThemeId = useCallback((id: string) => {
    setUiThemeIdState(id);
    void persistUiTheme(id);
  }, []);

  const value = useMemo<ThemeProviderState>(
    () => ({ theme, resolvedTheme, setTheme, uiThemeId, setUiThemeId }),
    [theme, resolvedTheme, setTheme, uiThemeId, setUiThemeId],
  );

  return (
    <ThemeProviderContext.Provider value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export function useTheme(): ThemeProviderState {
  const ctx = useContext(ThemeProviderContext);
  if (!ctx) throw new Error("useTheme must be used within a <ThemeProvider>");
  return ctx;
}
