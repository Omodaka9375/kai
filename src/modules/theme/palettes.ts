/**
 * UI theme palettes. Each theme provides a set of CSS custom-property
 * overrides for both light and dark modes. The "default" theme is a
 * no-op — it uses the values baked into globals.css.
 */

type CSSVars = Record<string, string>;

export type UiThemePalette = {
  id: string;
  label: string;
  /** Primary accent swatch color shown in the picker (oklch or hex). */
  swatch: string;
  light?: CSSVars;
  dark?: CSSVars;
};

export const UI_THEMES: readonly UiThemePalette[] = [
  {
    id: "default",
    label: "Kai",
    swatch: "#1e293b",
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    swatch: "#7aa2f7",
    dark: {
      "--background": "oklch(0.16 0.02 260)",
      "--foreground": "oklch(0.90 0.01 260)",
      "--card": "oklch(0.19 0.02 260)",
      "--card-foreground": "oklch(0.90 0.01 260)",
      "--popover": "oklch(0.19 0.02 260)",
      "--popover-foreground": "oklch(0.90 0.01 260)",
      "--primary": "oklch(0.72 0.12 260)",
      "--primary-foreground": "oklch(0.16 0.02 260)",
      "--secondary": "oklch(0.25 0.02 260)",
      "--secondary-foreground": "oklch(0.90 0.01 260)",
      "--muted": "oklch(0.25 0.02 260)",
      "--muted-foreground": "oklch(0.65 0.03 260)",
      "--accent": "oklch(0.25 0.02 260)",
      "--accent-foreground": "oklch(0.90 0.01 260)",
      "--destructive": "oklch(0.65 0.20 25)",
      "--border": "oklch(1 0 0 / 10%)",
      "--input": "oklch(1 0 0 / 15%)",
      "--ring": "oklch(0.72 0.12 260)",
    },
    light: {
      "--background": "oklch(0.97 0.005 260)",
      "--foreground": "oklch(0.20 0.02 260)",
      "--card": "oklch(1 0 0)",
      "--card-foreground": "oklch(0.20 0.02 260)",
      "--popover": "oklch(1 0 0)",
      "--popover-foreground": "oklch(0.20 0.02 260)",
      "--primary": "oklch(0.55 0.15 260)",
      "--primary-foreground": "oklch(0.98 0.005 260)",
      "--secondary": "oklch(0.94 0.01 260)",
      "--secondary-foreground": "oklch(0.20 0.02 260)",
      "--muted": "oklch(0.94 0.01 260)",
      "--muted-foreground": "oklch(0.50 0.03 260)",
      "--accent": "oklch(0.94 0.01 260)",
      "--accent-foreground": "oklch(0.20 0.02 260)",
      "--destructive": "oklch(0.58 0.24 27)",
      "--border": "oklch(0.90 0.01 260)",
      "--input": "oklch(0.90 0.01 260)",
      "--ring": "oklch(0.55 0.15 260)",
    },
  },
  {
    id: "nord",
    label: "Nord",
    swatch: "#88c0d0",
    dark: {
      "--background": "oklch(0.22 0.02 240)",
      "--foreground": "oklch(0.91 0.01 230)",
      "--card": "oklch(0.26 0.02 240)",
      "--card-foreground": "oklch(0.91 0.01 230)",
      "--popover": "oklch(0.26 0.02 240)",
      "--popover-foreground": "oklch(0.91 0.01 230)",
      "--primary": "oklch(0.76 0.08 210)",
      "--primary-foreground": "oklch(0.22 0.02 240)",
      "--secondary": "oklch(0.30 0.02 240)",
      "--secondary-foreground": "oklch(0.91 0.01 230)",
      "--muted": "oklch(0.30 0.02 240)",
      "--muted-foreground": "oklch(0.65 0.02 230)",
      "--accent": "oklch(0.30 0.02 240)",
      "--accent-foreground": "oklch(0.91 0.01 230)",
      "--destructive": "oklch(0.65 0.16 15)",
      "--border": "oklch(1 0 0 / 10%)",
      "--input": "oklch(1 0 0 / 15%)",
      "--ring": "oklch(0.76 0.08 210)",
    },
    light: {
      "--background": "oklch(0.96 0.005 230)",
      "--foreground": "oklch(0.25 0.02 240)",
      "--card": "oklch(0.99 0 0)",
      "--card-foreground": "oklch(0.25 0.02 240)",
      "--popover": "oklch(0.99 0 0)",
      "--popover-foreground": "oklch(0.25 0.02 240)",
      "--primary": "oklch(0.60 0.10 210)",
      "--primary-foreground": "oklch(0.98 0.005 230)",
      "--secondary": "oklch(0.93 0.01 230)",
      "--secondary-foreground": "oklch(0.25 0.02 240)",
      "--muted": "oklch(0.93 0.01 230)",
      "--muted-foreground": "oklch(0.50 0.02 230)",
      "--accent": "oklch(0.93 0.01 230)",
      "--accent-foreground": "oklch(0.25 0.02 240)",
      "--destructive": "oklch(0.58 0.24 27)",
      "--border": "oklch(0.88 0.01 230)",
      "--input": "oklch(0.88 0.01 230)",
      "--ring": "oklch(0.60 0.10 210)",
    },
  },
  {
    id: "catppuccin",
    label: "Catppuccin Mocha",
    swatch: "#cba6f7",
    dark: {
      "--background": "oklch(0.18 0.02 290)",
      "--foreground": "oklch(0.90 0.01 290)",
      "--card": "oklch(0.22 0.02 290)",
      "--card-foreground": "oklch(0.90 0.01 290)",
      "--popover": "oklch(0.22 0.02 290)",
      "--popover-foreground": "oklch(0.90 0.01 290)",
      "--primary": "oklch(0.75 0.14 300)",
      "--primary-foreground": "oklch(0.18 0.02 290)",
      "--secondary": "oklch(0.28 0.02 290)",
      "--secondary-foreground": "oklch(0.90 0.01 290)",
      "--muted": "oklch(0.28 0.02 290)",
      "--muted-foreground": "oklch(0.65 0.03 290)",
      "--accent": "oklch(0.28 0.02 290)",
      "--accent-foreground": "oklch(0.90 0.01 290)",
      "--destructive": "oklch(0.65 0.20 20)",
      "--border": "oklch(1 0 0 / 10%)",
      "--input": "oklch(1 0 0 / 15%)",
      "--ring": "oklch(0.75 0.14 300)",
    },
    light: {
      "--background": "oklch(0.96 0.008 290)",
      "--foreground": "oklch(0.22 0.02 290)",
      "--card": "oklch(0.99 0 0)",
      "--card-foreground": "oklch(0.22 0.02 290)",
      "--popover": "oklch(0.99 0 0)",
      "--popover-foreground": "oklch(0.22 0.02 290)",
      "--primary": "oklch(0.55 0.18 300)",
      "--primary-foreground": "oklch(0.98 0.005 290)",
      "--secondary": "oklch(0.93 0.01 290)",
      "--secondary-foreground": "oklch(0.22 0.02 290)",
      "--muted": "oklch(0.93 0.01 290)",
      "--muted-foreground": "oklch(0.50 0.03 290)",
      "--accent": "oklch(0.93 0.01 290)",
      "--accent-foreground": "oklch(0.22 0.02 290)",
      "--destructive": "oklch(0.58 0.24 27)",
      "--border": "oklch(0.88 0.01 290)",
      "--input": "oklch(0.88 0.01 290)",
      "--ring": "oklch(0.55 0.18 300)",
    },
  },
  {
    id: "dracula",
    label: "Dracula",
    swatch: "#bd93f9",
    dark: {
      "--background": "oklch(0.19 0.02 280)",
      "--foreground": "oklch(0.92 0.01 280)",
      "--card": "oklch(0.23 0.02 280)",
      "--card-foreground": "oklch(0.92 0.01 280)",
      "--popover": "oklch(0.23 0.02 280)",
      "--popover-foreground": "oklch(0.92 0.01 280)",
      "--primary": "oklch(0.72 0.16 295)",
      "--primary-foreground": "oklch(0.19 0.02 280)",
      "--secondary": "oklch(0.28 0.02 280)",
      "--secondary-foreground": "oklch(0.92 0.01 280)",
      "--muted": "oklch(0.28 0.02 280)",
      "--muted-foreground": "oklch(0.62 0.04 280)",
      "--accent": "oklch(0.28 0.02 280)",
      "--accent-foreground": "oklch(0.92 0.01 280)",
      "--destructive": "oklch(0.65 0.22 15)",
      "--border": "oklch(1 0 0 / 10%)",
      "--input": "oklch(1 0 0 / 15%)",
      "--ring": "oklch(0.72 0.16 295)",
    },
    light: {
      "--background": "oklch(0.97 0.005 280)",
      "--foreground": "oklch(0.22 0.02 280)",
      "--card": "oklch(1 0 0)",
      "--card-foreground": "oklch(0.22 0.02 280)",
      "--popover": "oklch(1 0 0)",
      "--popover-foreground": "oklch(0.22 0.02 280)",
      "--primary": "oklch(0.55 0.18 295)",
      "--primary-foreground": "oklch(0.98 0.005 280)",
      "--secondary": "oklch(0.94 0.01 280)",
      "--secondary-foreground": "oklch(0.22 0.02 280)",
      "--muted": "oklch(0.94 0.01 280)",
      "--muted-foreground": "oklch(0.50 0.03 280)",
      "--accent": "oklch(0.94 0.01 280)",
      "--accent-foreground": "oklch(0.22 0.02 280)",
      "--destructive": "oklch(0.58 0.24 27)",
      "--border": "oklch(0.90 0.01 280)",
      "--input": "oklch(0.90 0.01 280)",
      "--ring": "oklch(0.55 0.18 295)",
    },
  },
  {
    id: "rose-pine",
    label: "Rosé Pine",
    swatch: "#c4a7e7",
    dark: {
      "--background": "oklch(0.17 0.02 310)",
      "--foreground": "oklch(0.90 0.01 310)",
      "--card": "oklch(0.21 0.02 310)",
      "--card-foreground": "oklch(0.90 0.01 310)",
      "--popover": "oklch(0.21 0.02 310)",
      "--popover-foreground": "oklch(0.90 0.01 310)",
      "--primary": "oklch(0.75 0.10 320)",
      "--primary-foreground": "oklch(0.17 0.02 310)",
      "--secondary": "oklch(0.26 0.02 310)",
      "--secondary-foreground": "oklch(0.90 0.01 310)",
      "--muted": "oklch(0.26 0.02 310)",
      "--muted-foreground": "oklch(0.62 0.03 310)",
      "--accent": "oklch(0.26 0.02 310)",
      "--accent-foreground": "oklch(0.90 0.01 310)",
      "--destructive": "oklch(0.65 0.18 15)",
      "--border": "oklch(1 0 0 / 10%)",
      "--input": "oklch(1 0 0 / 15%)",
      "--ring": "oklch(0.75 0.10 320)",
    },
    light: {
      "--background": "oklch(0.97 0.005 310)",
      "--foreground": "oklch(0.22 0.02 310)",
      "--card": "oklch(0.99 0.002 310)",
      "--card-foreground": "oklch(0.22 0.02 310)",
      "--popover": "oklch(0.99 0.002 310)",
      "--popover-foreground": "oklch(0.22 0.02 310)",
      "--primary": "oklch(0.55 0.14 320)",
      "--primary-foreground": "oklch(0.98 0.005 310)",
      "--secondary": "oklch(0.93 0.01 310)",
      "--secondary-foreground": "oklch(0.22 0.02 310)",
      "--muted": "oklch(0.93 0.01 310)",
      "--muted-foreground": "oklch(0.50 0.03 310)",
      "--accent": "oklch(0.93 0.01 310)",
      "--accent-foreground": "oklch(0.22 0.02 310)",
      "--destructive": "oklch(0.58 0.24 27)",
      "--border": "oklch(0.88 0.01 310)",
      "--input": "oklch(0.88 0.01 310)",
      "--ring": "oklch(0.55 0.14 320)",
    },
  },
  {
    id: "emerald",
    label: "Emerald",
    swatch: "#34d399",
    dark: {
      "--background": "oklch(0.16 0.02 160)",
      "--foreground": "oklch(0.92 0.01 160)",
      "--card": "oklch(0.20 0.02 160)",
      "--card-foreground": "oklch(0.92 0.01 160)",
      "--popover": "oklch(0.20 0.02 160)",
      "--popover-foreground": "oklch(0.92 0.01 160)",
      "--primary": "oklch(0.75 0.15 165)",
      "--primary-foreground": "oklch(0.16 0.02 160)",
      "--secondary": "oklch(0.26 0.02 160)",
      "--secondary-foreground": "oklch(0.92 0.01 160)",
      "--muted": "oklch(0.26 0.02 160)",
      "--muted-foreground": "oklch(0.62 0.03 160)",
      "--accent": "oklch(0.26 0.02 160)",
      "--accent-foreground": "oklch(0.92 0.01 160)",
      "--destructive": "oklch(0.65 0.20 25)",
      "--border": "oklch(1 0 0 / 10%)",
      "--input": "oklch(1 0 0 / 15%)",
      "--ring": "oklch(0.75 0.15 165)",
    },
    light: {
      "--background": "oklch(0.97 0.005 160)",
      "--foreground": "oklch(0.20 0.02 160)",
      "--card": "oklch(1 0 0)",
      "--card-foreground": "oklch(0.20 0.02 160)",
      "--popover": "oklch(1 0 0)",
      "--popover-foreground": "oklch(0.20 0.02 160)",
      "--primary": "oklch(0.58 0.16 165)",
      "--primary-foreground": "oklch(0.98 0.005 160)",
      "--secondary": "oklch(0.94 0.01 160)",
      "--secondary-foreground": "oklch(0.20 0.02 160)",
      "--muted": "oklch(0.94 0.01 160)",
      "--muted-foreground": "oklch(0.50 0.03 160)",
      "--accent": "oklch(0.94 0.01 160)",
      "--accent-foreground": "oklch(0.20 0.02 160)",
      "--destructive": "oklch(0.58 0.24 27)",
      "--border": "oklch(0.88 0.01 160)",
      "--input": "oklch(0.88 0.01 160)",
      "--ring": "oklch(0.58 0.16 165)",
    },
  },
  {
    id: "amber",
    label: "Amber",
    swatch: "#f59e0b",
    dark: {
      "--background": "oklch(0.16 0.02 70)",
      "--foreground": "oklch(0.92 0.01 70)",
      "--card": "oklch(0.20 0.02 70)",
      "--card-foreground": "oklch(0.92 0.01 70)",
      "--popover": "oklch(0.20 0.02 70)",
      "--popover-foreground": "oklch(0.92 0.01 70)",
      "--primary": "oklch(0.78 0.16 75)",
      "--primary-foreground": "oklch(0.16 0.02 70)",
      "--secondary": "oklch(0.26 0.02 70)",
      "--secondary-foreground": "oklch(0.92 0.01 70)",
      "--muted": "oklch(0.26 0.02 70)",
      "--muted-foreground": "oklch(0.62 0.03 70)",
      "--accent": "oklch(0.26 0.02 70)",
      "--accent-foreground": "oklch(0.92 0.01 70)",
      "--destructive": "oklch(0.65 0.20 25)",
      "--border": "oklch(1 0 0 / 10%)",
      "--input": "oklch(1 0 0 / 15%)",
      "--ring": "oklch(0.78 0.16 75)",
    },
    light: {
      "--background": "oklch(0.97 0.005 70)",
      "--foreground": "oklch(0.20 0.02 70)",
      "--card": "oklch(1 0 0)",
      "--card-foreground": "oklch(0.20 0.02 70)",
      "--popover": "oklch(1 0 0)",
      "--popover-foreground": "oklch(0.20 0.02 70)",
      "--primary": "oklch(0.60 0.16 75)",
      "--primary-foreground": "oklch(0.98 0.005 70)",
      "--secondary": "oklch(0.94 0.01 70)",
      "--secondary-foreground": "oklch(0.20 0.02 70)",
      "--muted": "oklch(0.94 0.01 70)",
      "--muted-foreground": "oklch(0.50 0.03 70)",
      "--accent": "oklch(0.94 0.01 70)",
      "--accent-foreground": "oklch(0.20 0.02 70)",
      "--destructive": "oklch(0.58 0.24 27)",
      "--border": "oklch(0.88 0.01 70)",
      "--input": "oklch(0.88 0.01 70)",
      "--ring": "oklch(0.60 0.16 75)",
    },
  },
];

export const UI_THEME_MAP = new Map(UI_THEMES.map((t) => [t.id, t]));

// ── applyUiTheme ─────────────────────────────────────────────────────

/** Track the last-applied palette and keys so we only clear what we set. */
let _lastAppliedKeys: string[] = [];

/**
 * Apply a theme's CSS variables to the document root.
 * Pass "default" to clear all overrides and fall back to globals.css.
 */
export function applyUiTheme(themeId: string, mode: "light" | "dark"): void {
  const root = document.documentElement;

  // Clear only the keys we set last time — not every key from every theme.
  for (const key of _lastAppliedKeys) {
    root.style.removeProperty(key);
  }
  _lastAppliedKeys = [];

  if (!themeId || themeId === "default") return;

  const palette = UI_THEME_MAP.get(themeId);
  if (!palette) return;

  const vars = mode === "dark" ? palette.dark : palette.light;
  if (!vars) return;

  // Derive sidebar, chart, and radius values from the palette so every
  // UI surface matches — not just the main card/background area.
  const derived = deriveAuxiliaryVars(vars, mode);
  const allVars = { ...vars, ...derived };

  for (const [key, value] of Object.entries(allVars)) {
    root.style.setProperty(key, value);
    _lastAppliedKeys.push(key);
  }
}

// ── Auxiliary variable derivation ─────────────────────────────────────

/**
 * Derive --sidebar-*, --chart-*, and --radius values from the palette's
 * main variables. This keeps sidebars, charts, and border radius
 * consistent with the selected theme without requiring every palette
 * to define them explicitly.
 */
function deriveAuxiliaryVars(
  vars: Record<string, string>,
  mode: "light" | "dark",
): Record<string, string> {
  const bg = vars["--background"] ?? (mode === "dark" ? "oklch(0.16 0.02 260)" : "oklch(0.97 0.005 260)");
  const fg = vars["--foreground"] ?? (mode === "dark" ? "oklch(0.92 0.01 260)" : "oklch(0.20 0.02 260)");
  const primary = vars["--primary"] ?? (mode === "dark" ? "oklch(0.72 0.12 260)" : "oklch(0.55 0.15 260)");
  const muted = vars["--muted"] ?? (mode === "dark" ? "oklch(0.26 0.02 260)" : "oklch(0.94 0.01 260)");
  const border = vars["--border"] ?? (mode === "dark" ? "oklch(1 0 0 / 10%)" : "oklch(0.90 0.01 260)");
  const ring = vars["--ring"] ?? primary;

  // Sidebar: slightly offset from background for visual separation.
  const sidebarBg = shiftOklch(bg, "l", mode === "dark" ? 0.04 : -0.03);
  const sidebarAccent = shiftOklch(muted, "l", mode === "dark" ? 0.04 : -0.02);

  return {
    "--sidebar": sidebarBg,
    "--sidebar-foreground": fg,
    "--sidebar-primary": primary,
    "--sidebar-primary-foreground": bg,
    "--sidebar-accent": sidebarAccent,
    "--sidebar-accent-foreground": fg,
    "--sidebar-border": border,
    "--sidebar-ring": ring,
    // Chart: 5-step sequence derived from the primary hue.
    "--chart-1": primary,
    "--chart-2": shiftOklch(primary, "c", -0.1),
    "--chart-3": shiftOklch(primary, "l", 0.08),
    "--chart-4": shiftOklch(shiftOklch(primary, "l", -0.06), "c", -0.15),
    "--chart-5": shiftOklch(primary, "l", 0.14),
    "--radius": "0.625rem",
  };
}

/** Shift the lightness (l) or chroma (c) component of an oklch() color
 *  string by the given delta. Returns the original string if it doesn't
 *  match the expected format (e.g. hex, or oklch with alpha). */
function shiftOklch(
  oklch: string,
  component: "l" | "c",
  delta: number,
): string {
  const m = oklch.match(
    /^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)$/,
  );
  if (!m) return oklch;
  let l = parseFloat(m[1]);
  let c = parseFloat(m[2]);
  const h = m[3];
  if (component === "l") l = Math.max(0, Math.min(1, l + delta));
  else c = Math.max(0, c + delta);
  return `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${h})`;
}
