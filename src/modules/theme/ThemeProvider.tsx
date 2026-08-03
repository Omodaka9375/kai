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

// Synchronous fast-path so the initial paint isn't unstyled. The persistent
// preference (in tauri-plugin-store) overwrites this on mount; we keep a
// localStorage shadow of the *last applied* theme just for first-paint fidelity.
const FAST_PATH_KEY = "Kai-ui-theme-shadow";
const FAST_UI_THEME_KEY = "Kai-ui-theme-id-shadow";

function readFastTheme(fallback: Theme): Theme {
  if (typeof window === "undefined") return fallback;
  const v = window.localStorage.getItem(FAST_PATH_KEY);
  return v === "dark" || v === "light" || v === "system" ? v : fallback;
}

function writeFastTheme(t: Theme): void {
  try {
    window.localStorage.setItem(FAST_PATH_KEY, t);
  } catch {
    // ignore
  }
}

function readFastUiTheme(): string {
  if (typeof window === "undefined") return "default";
  return window.localStorage.getItem(FAST_UI_THEME_KEY) ?? "default";
}

function writeFastUiTheme(id: string): void {
  try {
    window.localStorage.setItem(FAST_UI_THEME_KEY, id);
  } catch {
    // ignore
  }
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(() =>
    readFastTheme(defaultTheme),
  );
  const [uiThemeId, setUiThemeIdState] = useState<string>(readFastUiTheme);
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
      writeFastTheme(p.theme);
      setUiThemeIdState(p.uiThemeId);
      writeFastUiTheme(p.uiThemeId);
    });
    const unlistenP = onPreferencesChange((key, value) => {
      // Guard: skip if the value matches current state — prevents the
      // window that originated the change from re-applying its own write.
      if (key === "theme" && (value === "system" || value === "light" || value === "dark")) {
        setThemeState((prev) => (prev === value ? prev : value));
        writeFastTheme(value);
      }
      if (key === "uiThemeId" && typeof value === "string") {
        setUiThemeIdState((prev) => (prev === value ? prev : value));
        writeFastUiTheme(value);
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
    writeFastTheme(next);
    void persistTheme(next);
  }, []);

  const setUiThemeId = useCallback((id: string) => {
    setUiThemeIdState(id);
    writeFastUiTheme(id);
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
