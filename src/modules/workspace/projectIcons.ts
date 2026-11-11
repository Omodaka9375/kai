import { useEffect, useReducer } from "react";
import type { IconSvgElement } from "@hugeicons/react";

/**
 * Project icon customization (2026-11-11).
 *
 * A project tile can carry a custom GLYPH and/or COLOR. Both are stored
 * keyed by the CANONICAL ROOT (not the runtime id): the id is a hash of
 * root+env and would change if the user switches the project's workspace
 * environment, while the folder is the stable identity the user thinks in.
 * AppShell persists the overrides in kai-open-projects.json under the
 * "projectIcons" key, independent of the open-roots list so closing a
 * project does not lose its customization.
 *
 * Icon values are hugeicons EXPORT NAMES (e.g. "RocketIcon"). Curated
 * glyphs resolve from a static per-icon deep-import map (kept out of any
 * single giant bundle); any other name lazily resolves from the full free
 * pack, which lives behind a dynamic import and is only fetched when a
 * non-curated icon is actually rendered or the picker search runs.
 *
 * Colors are preset KEYS ("red".."pink"); "auto"/undefined keeps the
 * deterministic per-project hash hue the rail has always used.
 */

export type ProjectIconColorKey =
  | "auto"
  | "red"
  | "orange"
  | "amber"
  | "emerald"
  | "cyan"
  | "blue"
  | "violet"
  | "pink";

/** Same muted family as the rail's original hash hue (45% 52%): enough to
 * tell tiles apart without fighting the theme. */
const COLOR_HUES: Record<Exclude<ProjectIconColorKey, "auto">, number> = {
  red: 0,
  orange: 24,
  amber: 45,
  emerald: 152,
  cyan: 189,
  blue: 217,
  violet: 262,
  pink: 330,
};

export const PROJECT_ICON_COLORS: Array<{ key: ProjectIconColorKey; label: string }> = [
  { key: "red", label: "Red" },
  { key: "orange", label: "Orange" },
  { key: "amber", label: "Amber" },
  { key: "emerald", label: "Emerald" },
  { key: "cyan", label: "Cyan" },
  { key: "blue", label: "Blue" },
  { key: "violet", label: "Violet" },
  { key: "pink", label: "Pink" },
];

/** Deterministic per-project hue: hash -> hsl(h, 45%, 52%). Same scheme the
 * rail used since day one, kept as the "auto" fallback. */
export function autoProjectIconColor(projectId: string): string {
  let h = 0;
  for (let i = 0; i < projectId.length; i++) {
    h = (h * 31 + projectId.charCodeAt(i)) >>> 0;
  }
  return `hsl(${h % 360} 45% 52%)`;
}

/** Resolve a tile's icon color: preset hue, or the project's auto hash. */
export function projectIconCss(color: string | undefined, projectId: string): string {
  if (color && color !== "auto" && color in COLOR_HUES) {
    return `hsl(${COLOR_HUES[color as Exclude<ProjectIconColorKey, "auto">]} 45% 52%)`;
  }
  return autoProjectIconColor(projectId);
}

// ---------------------------------------------------------------------------
// Curated glyph set - the "meaningful quickpick" grid shown before search.
// Deep per-icon imports (NOT the package index) so the main bundle only pays
// for these ~60 icons; the index itself stays lazy (see loadFullPack).
// ---------------------------------------------------------------------------

import AiBrain01Icon from "@hugeicons/core-free-icons/AiBrain01Icon";
import AiChat02Icon from "@hugeicons/core-free-icons/AiChat02Icon";
import AiChipIcon from "@hugeicons/core-free-icons/AiChipIcon";
import AiMagicIcon from "@hugeicons/core-free-icons/AiMagicIcon";
import AiNetworkIcon from "@hugeicons/core-free-icons/AiNetworkIcon";
import Atom01Icon from "@hugeicons/core-free-icons/Atom01Icon";
import Book02Icon from "@hugeicons/core-free-icons/Book02Icon";
import BookOpen01Icon from "@hugeicons/core-free-icons/BookOpen01Icon";
import Bookmark01Icon from "@hugeicons/core-free-icons/Bookmark01Icon";
import BotIcon from "@hugeicons/core-free-icons/BotIcon";
import Bug01Icon from "@hugeicons/core-free-icons/Bug01Icon";
import Calendar03Icon from "@hugeicons/core-free-icons/Calendar03Icon";
import Camera01Icon from "@hugeicons/core-free-icons/Camera01Icon";
import Chart01Icon from "@hugeicons/core-free-icons/Chart01Icon";
import Clock01Icon from "@hugeicons/core-free-icons/Clock01Icon";
import CloudIcon from "@hugeicons/core-free-icons/CloudIcon";
import CloudServerIcon from "@hugeicons/core-free-icons/CloudServerIcon";
import CodeIcon from "@hugeicons/core-free-icons/CodeIcon";
import ContainerIcon from "@hugeicons/core-free-icons/ContainerIcon";
import CpuIcon from "@hugeicons/core-free-icons/CpuIcon";
import DatabaseIcon from "@hugeicons/core-free-icons/DatabaseIcon";
import Dumbbell01Icon from "@hugeicons/core-free-icons/Dumbbell01Icon";
import FireIcon from "@hugeicons/core-free-icons/FireIcon";
import FirewallIcon from "@hugeicons/core-free-icons/FirewallIcon";
import GameController01Icon from "@hugeicons/core-free-icons/GameController01Icon";
import GitBranchIcon from "@hugeicons/core-free-icons/GitBranchIcon";
import GitForkIcon from "@hugeicons/core-free-icons/GitForkIcon";
import GithubIcon from "@hugeicons/core-free-icons/GithubIcon";
import GlobeIcon from "@hugeicons/core-free-icons/GlobeIcon";
import Home02Icon from "@hugeicons/core-free-icons/Home02Icon";
import Hospital01Icon from "@hugeicons/core-free-icons/Hospital01Icon";
import Image02Icon from "@hugeicons/core-free-icons/Image02Icon";
import Key02Icon from "@hugeicons/core-free-icons/Key02Icon";
import Layers01Icon from "@hugeicons/core-free-icons/Layers01Icon";
import Leaf01Icon from "@hugeicons/core-free-icons/Leaf01Icon";
import Link02Icon from "@hugeicons/core-free-icons/Link02Icon";
import MapPinIcon from "@hugeicons/core-free-icons/MapPinIcon";
import Mortarboard01Icon from "@hugeicons/core-free-icons/Mortarboard01Icon";
import MusicNote01Icon from "@hugeicons/core-free-icons/MusicNote01Icon";
import Note01Icon from "@hugeicons/core-free-icons/Note01Icon";
import Notebook01Icon from "@hugeicons/core-free-icons/Notebook01Icon";
import PackageIcon from "@hugeicons/core-free-icons/PackageIcon";
import PencilRulerIcon from "@hugeicons/core-free-icons/PencilRulerIcon";
import PlaneIcon from "@hugeicons/core-free-icons/PlaneIcon";
import PuzzleIcon from "@hugeicons/core-free-icons/PuzzleIcon";
import RocketIcon from "@hugeicons/core-free-icons/RocketIcon";
import SchoolIcon from "@hugeicons/core-free-icons/SchoolIcon";
import ServerStack01Icon from "@hugeicons/core-free-icons/ServerStack01Icon";
import ShoppingBag01Icon from "@hugeicons/core-free-icons/ShoppingBag01Icon";
import SmartPhone01Icon from "@hugeicons/core-free-icons/SmartPhone01Icon";
import SourceCodeIcon from "@hugeicons/core-free-icons/SourceCodeIcon";
import StarIcon from "@hugeicons/core-free-icons/StarIcon";
import TerminalIcon from "@hugeicons/core-free-icons/TerminalIcon";
import TestTubeIcon from "@hugeicons/core-free-icons/TestTubeIcon";
import Tree01Icon from "@hugeicons/core-free-icons/Tree01Icon";
import Wallet01Icon from "@hugeicons/core-free-icons/Wallet01Icon";
import WorkflowSquare03Icon from "@hugeicons/core-free-icons/WorkflowSquare03Icon";
import Wrench01Icon from "@hugeicons/core-free-icons/Wrench01Icon";

/** Curated groups: export name -> preloaded glyph. Order is display order. */
export const CURATED_PROJECT_ICONS: Array<{ group: string; icons: Record<string, IconSvgElement> }> = [
  {
    group: "Development",
    icons: {
      SourceCodeIcon,
      CodeIcon,
      TerminalIcon,
      GitBranchIcon,
      GitForkIcon,
      Bug01Icon,
      TestTubeIcon,
      WorkflowSquare03Icon,
    },
  },
  {
    group: "AI",
    icons: {
      AiBrain01Icon,
      AiChat02Icon,
      AiChipIcon,
      AiMagicIcon,
      AiNetworkIcon,
      BotIcon,
    },
  },
  {
    group: "Data & infra",
    icons: {
      DatabaseIcon,
      CloudIcon,
      CloudServerIcon,
      ServerStack01Icon,
      ContainerIcon,
      PackageIcon,
      FirewallIcon,
      Key02Icon,
    },
  },
  {
    group: "Web",
    icons: { GlobeIcon, Link02Icon, GithubIcon },
  },
  {
    group: "Docs",
    icons: {
      Book02Icon,
      BookOpen01Icon,
      Note01Icon,
      Notebook01Icon,
      Bookmark01Icon,
      Mortarboard01Icon,
    },
  },
  {
    group: "Media & design",
    icons: { PencilRulerIcon, Image02Icon, Camera01Icon, MusicNote01Icon },
  },
  {
    group: "Life & misc",
    icons: {
      RocketIcon,
      Wrench01Icon,
      CpuIcon,
      SmartPhone01Icon,
      Home02Icon,
      MapPinIcon,
      Calendar03Icon,
      Clock01Icon,
      PlaneIcon,
      Dumbbell01Icon,
      Leaf01Icon,
      Tree01Icon,
      GameController01Icon,
      StarIcon,
      FireIcon,
      Atom01Icon,
      PuzzleIcon,
      Layers01Icon,
      Chart01Icon,
      Wallet01Icon,
      ShoppingBag01Icon,
      SchoolIcon,
      Hospital01Icon,
    },
  },
];

const CURATED_INDEX: Record<string, IconSvgElement> = Object.fromEntries(
  CURATED_PROJECT_ICONS.flatMap((entry) => Object.entries(entry.icons)),
);

/** Strip the "Icon" suffix for tooltips / search display. */
export function iconDisplayName(name: string): string {
  return name.endsWith("Icon") ? name.slice(0, -4) : name;
}

// ---------------------------------------------------------------------------
// Lazy full-pack resolution (~5,100 glyphs, own dynamic chunk).
// ---------------------------------------------------------------------------

type IconPack = Record<string, IconSvgElement>;

let fullPack: IconPack | null = null;
let fullPackPromise: Promise<IconPack> | null = null;
const packListeners = new Set<() => void>();
const resolvedIcons = new Map<string, IconSvgElement>();
const iconSubscribers = new Set<() => void>();

/** Start loading the full pack. Resolves with the whole export namespace;
 * the promise is cached module-level so callers race harmlessly. */
export function loadFullPack(): Promise<IconPack> {
  fullPackPromise ??= import("@hugeicons/core-free-icons").then((pack) => {
    fullPack = pack as IconPack;
    for (const listener of packListeners) listener();
    return fullPack;
  });
  return fullPackPromise;
}

export function getFullPack(): IconPack | null {
  return fullPack;
}

export function subscribeFullPack(listener: () => void): () => void {
  packListeners.add(listener);
  return () => {
    packListeners.delete(listener);
  };
}

function lookupIcon(name: string): IconSvgElement | undefined {
  return CURATED_INDEX[name] ?? resolvedIcons.get(name);
}

/** Resolve a glyph for a tile: curated (static) immediately; anything else
 * via the lazy pack, re-rendering when it lands. Unknown names fall back to
 * the caller's default (the folder glyph) without erroring. */
export function useProjectIcon(name: string | undefined): IconSvgElement | undefined {
  // Hooks run unconditionally; early data-dependent behavior happens after.
  const [, force] = useReducer((n: number) => n + 1, 0);
  const staticIcon = name ? CURATED_INDEX[name] : undefined;
  useEffect(() => {
    if (!name || staticIcon) return;
    if (lookupIcon(name)) return;
    void loadFullPack().then((pack) => {
      const icon = pack[name];
      if (icon) resolvedIcons.set(name, icon);
      // Notify even on a miss so a stale-name tile stops waiting forever.
      for (const listener of iconSubscribers) listener();
    });
    iconSubscribers.add(force);
    return () => {
      iconSubscribers.delete(force);
    };
  }, [name, staticIcon, force]);
  return name ? lookupIcon(name) : undefined;
}
