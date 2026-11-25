/**
 * Per-project trust registry (2026-11-25, "cloned repos running shell on
 * open" hardening).
 *
 * THREAT MODEL: a cloned repository can ship agent INSTRUCTIONS - KAI.md,
 * subdirectory KAI.md files, .kai/rules/*.md, project MEMORY.md, and skill
 * bodies are all loaded into the system prompt on demand. That is the
 * feature ("agent memory"), but it means an unknown repo ships prompt
 * content, not just code. Under auto-approve ("Allow") a well-crafted rules
 * file could steer the agent into running commands with zero approval
 * cards. Direct shell execution on open/clone is already impossible (shell
 * init never sources repo files, nothing auto-runs on project open, git
 * uses --no-textconv); this module closes the INDIRECT path.
 *
 * CONTRACT:
 *  - FIRST RUN: every project in kai-open-projects.json is seeded TRUSTED
 *    (in-flight workflows keep working; no surprise amber banners for
 *    existing users).
 *  - A project NOT in the registry (newly cloned/opened) is UNTRUSTED:
 *    every approval-resolution surface for its sessions ignores Allow mode
 *    (Ask is forced), and the agent's prompt gets an <untrusted-project>
 *    notice over the project-rules block.
 *  - Trust is one click on the TrustStrip banner in the AI window (or the
 *    rail tile's context menu) and reversible from the same menu.
 *  - Sessionless/rootless surfaces (no project = no repo-sourced prompt
 *    content) count as trusted - there is nothing to distrust.
 *
 * Storage: kai-workspace-trust.json, key "trust" -> { migrated: boolean,
 * trusted: string[] }. Project ids are the canonical projectIdFor form
 * (scope + normalized root), so a WSL project and its local twin are
 * distinct trust decisions.
 */

import { LazyStore } from "@tauri-apps/plugin-store";

const store = new LazyStore("kai-workspace-trust.json", { defaults: {}, autoSave: 200 });
const KEY = "trust";

type TrustFile = { migrated?: boolean; trusted?: string[] };

const trusted = new Set<string>();
const listeners = new Set<() => void>();
let hydration: Promise<void> | null = null;
let hydrated = false;
let version = 0;

function notify(): void {
  version++;
  for (const listener of listeners) listener();
}

function persist(migrated: boolean): void {
  void store.set(KEY, {
    migrated,
    trusted: Array.from(trusted),
  } satisfies TrustFile);
}

/**
 * Hydrate from disk, then seed on first run: when the file has no
 * `migrated` marker, mark every currently-open project trusted and write
 * the marker. Later hydrates (app restarts) only read - projects opened
 * after the marker exist WITHOUT a trust entry and stay untrusted until
 * the user trusts them.
 */
export function hydrateWorkspaceTrust(openProjectIds: string[]): Promise<void> {
  hydration ??= (async () => {
    try {
      const file = (await store.get<TrustFile>(KEY)) ?? {};
      if (Array.isArray(file.trusted)) {
        for (const id of file.trusted) trusted.add(id);
      }
      if (!file.migrated) {
        for (const id of openProjectIds) trusted.add(id);
        persist(true);
      }
      hydrated = true;
      notify();
    } catch {
      // STORAGE-FAILURE FAIL-OPEN (2026-11-25 "don't break existing
      // projects" review): if the trust store cannot be read, the
      // alternative is EVERY project reading untrusted -> Allow users
      // silently stuck in Ask with no banner (the banner defers on
      // isWorkspaceTrustHydrated, which would stay false forever). Degrade
      // to trusting the CURRENTLY OPEN projects (memory-only, nothing
      // persisted) and mark hydrated so the UI works. A retry happens on
      // the next app launch.
      for (const id of openProjectIds) trusted.add(id);
      hydrated = true;
      notify();
    }
  })();
  return hydration;
}

/** True once the registry has loaded (or seeded). Banner UI defers to this
 *  so the strip never flashes on boot. */
export function isWorkspaceTrustHydrated(): boolean {
  return hydrated;
}

/**
 * Fail-closed for KNOWN projects, fail-open for the ABSENCE of a project:
 * a null/undefined id means the surface has no project (rootless session,
 * StartPage chat) - there are no repo-sourced rules to distrust, so Allow
 * mode stays meaningful there.
 */
export function isWorkspaceTrusted(projectId: string | null | undefined): boolean {
  if (!projectId) return true;
  return trusted.has(projectId);
}

export function trustWorkspace(projectId: string): void {
  if (trusted.has(projectId)) return;
  trusted.add(projectId);
  persist(true);
  notify();
}

export function untrustWorkspace(projectId: string): void {
  if (!trusted.delete(projectId)) return;
  persist(true);
  notify();
}

/** All trusted project ids (Settings/diagnostics). */
export function trustedProjects(): string[] {
  return Array.from(trusted);
}

/** Reactive version counter for useSyncExternalStore subscribers. */
export function getWorkspaceTrustVersion(): number {
  return version;
}

export function subscribeWorkspaceTrust(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
