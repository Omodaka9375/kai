import { LazyStore } from "@tauri-apps/plugin-store";
import { z } from "zod";
import { SIDEBAR_WIDTH_DEFAULT, clampSidebarWidth } from "@/modules/settings/store";

export type SidebarLayout = {
  width: number;
  collapsed: boolean;
};

/** `panelOpen=false` is closed; `panelOpen=true, open=false` is minimized. */
export type AiWindowLayout = {
  open: boolean;
  expanded: boolean;
  panelOpen: boolean;
};

export type ProjectLayout = {
  sidebar: SidebarLayout;
  aiWindow: AiWindowLayout;
};

const storedLayoutSchema = z.object({
  sidebar: z.object({
    width: z.number().optional(),
    collapsed: z.boolean().optional(),
  }).optional(),
  aiWindow: z.object({
    open: z.boolean().optional(),
    expanded: z.boolean().optional(),
    panelOpen: z.boolean().optional(),
  }).optional(),
});
// Validate each record separately: one corrupt project must not discard every
// other project's saved layout.
const storedLayoutsSchema = z.record(z.string(), z.unknown());
type StoredProjectLayout = z.infer<typeof storedLayoutSchema>;

const store = new LazyStore("kai-project-layouts.json", {
  defaults: {},
  autoSave: false,
});
const layouts = new Map<string, ProjectLayout>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

export const DEFAULT_PROJECT_LAYOUT: ProjectLayout = {
  sidebar: { width: SIDEBAR_WIDTH_DEFAULT, collapsed: false },
  aiWindow: {
    open: false,
    expanded: false,
    panelOpen: false,
  },
};

function normalizeLayout(saved?: StoredProjectLayout): ProjectLayout {
  return {
    sidebar: {
      width: clampSidebarWidth(saved?.sidebar?.width ?? SIDEBAR_WIDTH_DEFAULT),
      collapsed: saved?.sidebar?.collapsed ?? false,
    },
    aiWindow: {
      open: saved?.aiWindow?.open ?? false,
      expanded: saved?.aiWindow?.expanded ?? false,
      panelOpen: saved?.aiWindow?.panelOpen ?? false,
    },
  };
}

export async function hydrateProjectLayouts(): Promise<void> {
  const raw: unknown = await store.get("layouts");
  const parsed = storedLayoutsSchema.safeParse(raw);
  layouts.clear();
  if (parsed.success) {
    for (const [projectId, saved] of Object.entries(parsed.data)) {
      const valid = storedLayoutSchema.safeParse(saved);
      if (valid.success) layouts.set(projectId, normalizeLayout(valid.data));
    }
  }
}

export function getProjectLayout(projectId: string): ProjectLayout {
  return layouts.get(projectId) ?? DEFAULT_PROJECT_LAYOUT;
}

function snapshot(): Record<string, ProjectLayout> {
  return Object.fromEntries(layouts);
}

async function writeSnapshot(): Promise<void> {
  try {
    await store.set("layouts", snapshot());
    await store.save();
  } catch (error) {
    console.warn("[Kai] project layout save failed:", error);
  }
}

function enqueueWrite(): Promise<void> {
  writeQueue = writeQueue.then(writeSnapshot, writeSnapshot);
  return writeQueue;
}

function scheduleWrite(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void enqueueWrite();
  }, 150);
}

/** Flush pending sidebar/AI-state changes on workspace unmount. */
export async function flushProjectLayouts(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await enqueueWrite();
}

export function patchProjectLayout(
  projectId: string,
  patch: {
    sidebar?: Partial<SidebarLayout>;
    aiWindow?: Partial<AiWindowLayout>;
  },
): void {
  const previous = getProjectLayout(projectId);
  const next = normalizeLayout({
    sidebar: { ...previous.sidebar, ...patch.sidebar },
    aiWindow: { ...previous.aiWindow, ...patch.aiWindow },
  });
  if (JSON.stringify(next) === JSON.stringify(previous)) return;
  layouts.set(projectId, next);
  scheduleWrite();
}

export const __projectLayoutForTest = {
  clear(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    layouts.clear();
    writeQueue = Promise.resolve();
  },
};
