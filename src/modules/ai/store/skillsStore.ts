/**
 * Skills store — the runtime face of lib/skills.ts.
 *
 * TWO SCOPES:
 *  - global (`~/.kai/skills`): every project, survives restarts — the
 *    "save permanently to KAI" scope the user asked for.
 *  - project (`<root>/.kai/skills`): this repo only, checked into VCS.
 *
 * MIGRATION (one-time, idempotent): the legacy `kai-snippets.json` entries
 * are written into the global scope as skill folders (handle preserved,
 * `#handle` tokens keep working). The old file is left on disk untouched
 * as a backup. Factory seeds re-seed when missing, same as the old
 * snippet system's hydrate behavior.
 *
 * Replaces store/snippetsStore.ts (2026-11-02). The in-file CHANGED_EVENT
 * pattern survives so a Settings-window write refreshes the main window's
 * composer picker.
 */

import { emit, listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { currentWorkspaceEnv } from "@/modules/workspace/env";
import {
  BUILTIN_SKILLS,
  globalSkillsRoot,
  legacySnippetToDraft,
  mergeSkills,
  projectSkillsRoot,
  scanSkills,
  skillExists,
  writeSkill,
  type Skill,
  type SkillDraft,
} from "../lib/skills";

const CHANGED_EVENT = "Kai://ai-skills-changed";
const LEGACY_SNIPPETS_STORE = "kai-snippets.json";
const LEGACY_SNIPPETS_KEY = "snippets";

type State = {
  hydrated: boolean;
  /** Global scope only (project skills resolve via projectSkills()). */
  globalSkills: Skill[];
  hydrate: (projectRoot?: string | null) => Promise<void>;
  /** Merged view for a project root (global + project, project wins). */
  projectSkills: (projectRoot: string | null | undefined) => Skill[];
  upsert: (draft: SkillDraft, scope: "global" | "project", projectRoot?: string | null) => Promise<void>;
  remove: (name: string, scope: "global" | "project", projectRoot?: string | null) => Promise<void>;
};

/** One-shot migration guard (module scope — one run per process). */
let migrationRan = false;
/** Event listener armed once per process. */
let listenerArmed = false;
const projectCache = new Map<string, Skill[]>();

type LegacySnippetRow = {
  handle: string;
  name: string;
  description: string;
  content: string;
  mcpServerIds?: string[];
};

async function readLegacySnippets(): Promise<LegacySnippetRow[]> {
  try {
    const { LazyStore } = await import("@tauri-apps/plugin-store");
    const legacy = new LazyStore(LEGACY_SNIPPETS_STORE, { defaults: {}, autoSave: 200 });
    return ((await legacy.get<LegacySnippetRow[]>(LEGACY_SNIPPETS_KEY)) ?? []);
  } catch {
    return [];
  }
}

async function migrateLegacyAndSeed(force = false): Promise<void> {
  if (migrationRan && !force) return;
  migrationRan = true;
  const root = await globalSkillsRoot();
  await invokeCreateDir(root);
  // 1. Legacy snippets → global skill folders (skip ones already migrated).
  const legacy = await readLegacySnippets();
  for (const snip of legacy) {
    const draft = legacySnippetToDraft(snip);
    if (!draft.name || !draft.content?.trim()) continue;
    try {
      if (!(await skillExists(root, draft.name, null))) {
        await writeSkill(root, draft, null);
      }
    } catch {
      // one bad snippet never blocks the rest
    }
  }
  // 2. Factory seeds — add when missing (fresh install or deleted seed).
  for (const seed of BUILTIN_SKILLS) {
    try {
      if (!(await skillExists(root, seed.name, null))) {
        await writeSkill(root, seed, null);
      }
    } catch {
      // best-effort
    }
  }
}

async function invokeCreateDir(path: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("fs_create_dir", { path, workspace: null }).catch(() => {});
}

export const useSkillsStore = create<State>((set, get) => ({
  hydrated: false,
  globalSkills: [],
  hydrate: async (projectRoot) => {
    await migrateLegacyAndSeed();
    const root = await globalSkillsRoot();
    const globalSkills = await scanSkills(root, "global", null);
    set({ globalSkills, hydrated: true });
    if (projectRoot) {
      const env = currentWorkspaceEnv();
      const skills = await scanSkills(projectSkillsRoot(projectRoot), "project", env);
      projectCache.set(projectRoot, skills);
    }
    void projectRoot;
    if (!listenerArmed) {
      listenerArmed = true;
      void listen(CHANGED_EVENT, async () => {
        // Re-scan global + cached project roots.
        const g = await scanSkills(await globalSkillsRoot(), "global", null);
        set({ globalSkills: g });
        for (const root of projectCache.keys()) {
          const skills = await scanSkills(projectSkillsRoot(root), "project", currentWorkspaceEnv());
          projectCache.set(root, skills);
        }
      });
    }
  },
  projectSkills: (projectRoot) => {
    if (!projectRoot) return get().globalSkills;
    const project = projectCache.get(projectRoot) ?? [];
    return mergeSkills(get().globalSkills, project);
  },
  upsert: async (draft, scope, projectRoot) => {
    const root = scope === "global"
      ? await globalSkillsRoot()
      : projectRoot
        ? projectSkillsRoot(projectRoot)
        : null;
    if (!root) throw new Error("project scope needs a project root");
    await writeSkill(root, draft, scope === "global" ? null : currentWorkspaceEnv());
    // Refresh the affected scope in-place.
    if (scope === "global") {
      const g = await scanSkills(await globalSkillsRoot(), "global", null);
      set({ globalSkills: g });
    } else if (projectRoot) {
      const skills = await scanSkills(projectSkillsRoot(projectRoot), "project", currentWorkspaceEnv());
      projectCache.set(projectRoot, skills);
    }
    await emit(CHANGED_EVENT);
  },
  remove: async (name, scope, projectRoot) => {
    const root = scope === "global"
      ? await globalSkillsRoot()
      : projectRoot
        ? projectSkillsRoot(projectRoot)
        : null;
    if (!root) throw new Error("project scope needs a project root");
    const { deleteSkill } = await import("../lib/skills");
    await deleteSkill(root, name, scope === "global" ? null : currentWorkspaceEnv());
    if (scope === "global") {
      const g = await scanSkills(await globalSkillsRoot(), "global", null);
      set({ globalSkills: g });
    } else if (projectRoot) {
      const skills = await scanSkills(projectSkillsRoot(projectRoot), "project", currentWorkspaceEnv());
      projectCache.set(projectRoot, skills);
    }
    await emit(CHANGED_EVENT);
  },
}));

/** Tell every window (composer # picker, Settings) that skills changed on
 *  disk. Called by the agent-authoring tools (tools/skills.ts) after a
 *  successful create/update — the tool writes via lib/skills.ts directly,
 *  bypassing this store's upsert, so without this nudge the main window's
 *  picker stays stale until the next hydrate/project activation (the
 *  2026-11-03 report: agent-created skill visible in Settings but not
 *  under #). Fire-and-forget; the listener re-scans global + cached roots. */
export function notifySkillsChanged(): void {
  void emit(CHANGED_EVENT);
}

/** Re-scan just one project root (called when a project becomes active).
 *  Cheap: one dir read + N SKILL.md reads; folders are typically few.
 *  Null root = no project (global-only view) — no-op. */
export async function refreshProjectSkills(projectRoot: string | null | undefined): Promise<void> {
  if (!projectRoot) return;
  if (!useSkillsStore.getState().hydrated) return;
  const skills = await scanSkills(projectSkillsRoot(projectRoot), "project", currentWorkspaceEnv());
  projectCache.set(projectRoot, skills);
}

/** Snapshot of merged skills for a project (used by tools + composer). */
export function skillsForProject(projectRoot: string | null | undefined): Skill[] {
  return useSkillsStore.getState().projectSkills(projectRoot);
}

export { projectSkillsRoot, globalSkillsRoot };
