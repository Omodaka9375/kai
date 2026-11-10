/**
 * WorkspaceActivationGate — the 2026-11-02 switch-lag fix, round 2.
 *
 * User report: "project switching is much better now, but still lags when
 * switching between two projects where agents are actively thinking or
 * writing."
 *
 * Root cause: `isActive` was a PROP on the memoized ProjectWorkspace. React's
 * memo can only skip work when props are unchanged — a switch flips the prop
 * on exactly TWO workspaces, so BOTH fully reconciled (header, explorer,
 * stacks, panels, dialogs — thousands of elements), every switch, forever.
 * With active agent streams those trees are large AND being pumped by token
 * flushes (AgentRunBridge re-renders per 50ms throttle flush), so the switch
 * transition kept getting interrupted mid-reconcile.
 *
 * Fix: activation rides WorkspaceActiveContext. The workspace BODY never
 * subscribes (renders once per mount; its own state changes still re-render
 * it, which is correct). All activation-gated APP-LEVEL EFFECTS live in THIS
 * gate — a null-rendering child that re-renders only on the context flip and
 * a few scalar props. Its re-render is free; its effects do the same
 * app-level writes as before (already startTransition'd where they touch
 * global stores).
 *
 * The visual/behavioral flip lives in small context subscribers:
 * TerminalStack/PreviewStack (visibility classes), FileMenuGate,
 * ActiveSurfaces (mini window / group pill), AgentRunBridge (internal),
 * ProjectSessionStamp. Document-level listeners stay in the body but check
 * isActiveRef inside the handler (a ref check is equivalent to a gated
 * subscription for a passive listener and avoids re-subscribe churn).
 *
 * The heavy workspace tree simply never re-renders on a project switch.
 */

import { useEffect, useRef, startTransition } from "react";
import { homeDir } from "@tauri-apps/api/path";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  useProjectRuntime,
  useWorkspaceActive,
  type ProjectRuntime,
} from "@/modules/workspace";
import { useWorkspaceEnvStore } from "@/modules/workspace/env";
import { normalizeWorkspacePath } from "@/modules/ai/lib/workspacePath";
import { getLaunchDir } from "@/lib/launchDir";
import {
  getProjectActiveSession,
  getProjectModel,
  setActiveProjectRuntime,
  setProjectActiveSession,
  setProjectModel,
  projectIdForSession,
  useChatStore,
} from "@/modules/ai/store/chatStore";
import { setSessionPreferences } from "@/modules/ai/store/sessionPreferences";
import { useAgentsStore } from "@/modules/ai/store/agentsStore";
import { useSkillsStore, refreshProjectSkills } from "@/modules/ai/store/skillsStore";
import { useMcpStore } from "@/modules/ai/store/mcpStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setLastWorkspaceCwd, setRecentProjects } from "@/modules/settings/store";
import type { ModelId } from "@/modules/ai/config";

export type ActivationGateProps = {
  explorerRoot: string | null;
  launchCwd: string | null;
  home: string | null;
  prefsHydrated: boolean;
  launchCwdResolved: boolean;
  /** Window-title label (last path segment). */
  projectName: string | null;
  /** chatStore action — hydrates the incoming project's sessions. */
  hydrateSessions: (root: string | null | undefined, runtime: ProjectRuntime) => Promise<void>;
  /** Rail-switch entry ("open project" window events). */
  openProject: (path: string) => void;
  /** Sidebar px snapshot for the --kai-workspace-left CSS var write. */
  getSidebarPx: () => number;
  writeWorkspaceLeft: (px: number) => void;
  /** setLive + setSandboxRoot with the body's freshest refs. */
  onActivateLive: () => void;
  /** Launch-cwd resolution state (body-owned). */
  setLaunchCwd: (v: string | null) => void;
  setLaunchCwdResolved: (v: boolean) => void;
  /** Body's _setRoot — pin the workspace root once cwd resolves. */
  setRoot: (cwd: string) => void;
  /** Per-project model catalog + global default (restore effect). */
  projectModelIds: Record<string, string>;
  prefDefaultModel: string;
};

export function WorkspaceActivationGate(props: ActivationGateProps) {
  const isActive = useWorkspaceActive();
  const projectRuntime = useProjectRuntime();
  const setWorkspaceEnv = useWorkspaceEnvStore((s) => s.setEnv);
  const {
    explorerRoot, launchCwd, home, prefsHydrated, launchCwdResolved,
    projectName, hydrateSessions, openProject, getSidebarPx,
    writeWorkspaceLeft, onActivateLive, setLaunchCwd, setLaunchCwdResolved,
    setRoot, projectModelIds, prefDefaultModel,
  } = props;

  // ── Expanded-AI-window left offset (moved from the body 2026-11-02) ──────
  // Only the foreground workspace may write --kai-workspace-left, and it
  // re-syncs on every activation (a switch resizes nothing; without the
  // re-sync the incoming project's expanded window rendered at the outgoing
  // project's offset).
  useEffect(() => {
    if (!isActive) return;
    writeWorkspaceLeft(getSidebarPx());
  }, [isActive, getSidebarPx, writeWorkspaceLeft]);

  // ── Launch-cwd resolution (first activation per workspace) ───────────────
  useEffect(() => {
    if (!isActive) return;
    const resolveCwd = async (): Promise<string | null> => {
      const launch = projectRuntime?.root ?? getLaunchDir();
      if (launch) return launch;
      // A prefs-init failure (corrupt/locked store under a second concurrent
      // instance) must not block root resolution — fall through to home.
      try {
        await usePreferencesStore.getState().init();
      } catch (e) {
        console.warn("[Kai] launch: preferences init failed:", e);
      }
      // LAN-only network policy hook: security.ts checkShellCommand reads
      // this instead of importing the preferences store (avoids a settings
      // circular import). Lazy getter - every call reads the live store.
      (globalThis as { __kaiLanOnlyPolicy?: () => boolean }).__kaiLanOnlyPolicy =
        () => usePreferencesStore.getState().networkPolicy === "lan";
      const saved = usePreferencesStore.getState().lastWorkspaceCwd;
      if (saved) return saved;
      try {
        return (await homeDir()).replace(/\\/g, "/");
      } catch {
        return null;
      }
    };
    // Watchdog: prefs hydration / the store plugin can wedge. 5s is far
    // beyond a healthy resolve; pin the root anyway so the explorer /
    // sessions / AI have a workspace even though no tab spawns.
    const watchdog = setTimeout(() => {
      console.error(
        "[Kai] launch: cwd resolution did not settle in 5s — pinning fallback workspace root",
      );
      setLaunchCwdResolved(true);
      setRoot(home ?? "");
    }, 5000);
    resolveCwd()
      .then((cwd) => {
        clearTimeout(watchdog);
        setLaunchCwd(cwd);
        setLaunchCwdResolved(true);
        // Pin the workspace root to the launch directory so the explorer /
        // AI sessions resolve against the right project. Every launch stays
        // on the StartPage: no mount-time PTY racing the renderer bind.
        if (cwd) setRoot(cwd);
      })
      .catch((e) => {
        clearTimeout(watchdog);
        console.error("[Kai] launch: cwd resolution failed:", e);
        setLaunchCwdResolved(true);
        setRoot(home ?? "");
      });
  }, [isActive, projectRuntime]);

  // ── Open-project window events (foreground listener only) ────────────────
  useEffect(() => {
    if (!isActive) return;
    const promise = listen<string>("Kai://open-project", (event) => {
      const path = event.payload;
      if (!path) return;
      openProject(path.replace(/\\/g, "/"));
    });
    return () => {
      void promise.then((un) => un());
    };
  }, [isActive, openProject]);

  // ── Window title reflects the foreground project ─────────────────────────
  useEffect(() => {
    if (!isActive) return;
    const w = getCurrentWindow();
    const title = projectName ?? "KAI";
    void w.setTitle(title);
    document.title = title;
  }, [projectName, isActive]);

  // ── Persist recents (foreground only; guarded on prefs hydration) ────────
  useEffect(() => {
    if (!isActive || !explorerRoot || !prefsHydrated) return;
    void setLastWorkspaceCwd(explorerRoot);
    try {
      const normalized = explorerRoot.replace(/\\/g, "/").replace(/\/$/, "");
      const list = usePreferencesStore.getState().recentProjects || [];
      const next = [normalized, ...list.filter((p) => p !== normalized)].slice(0, 10);
      void setRecentProjects(next);
    } catch {
      // ignore
    }
  }, [explorerRoot, prefsHydrated, isActive]);

  // ── Per-project model restore (activation flip — not just root change) ──
  const projectModelApplied = useRef<string | null>(null);
  useEffect(() => {
    if (!prefsHydrated || !projectRuntime) return;
    const root = normalizeWorkspacePath(explorerRoot);
    const key = isActive ? root : "";
    if (key === projectModelApplied.current) return;
    projectModelApplied.current = key;
    if (!isActive) return;
    const saved = root ? projectModelIds[root] : undefined;
    const model = (saved ?? prefDefaultModel) as ModelId;
    // RESTORE, not user selection: activate first so setProjectModel lands
    // on the INCOMING project; the outgoing project's captured model stays
    // untouched. Stamping unconditionally hit the OUTGOING project's
    // still-active session with the incoming project's model — the
    // cross-project bleed.
    setActiveProjectRuntime(projectRuntime);
    setProjectModel(projectRuntime.id, model, useAgentsStore.getState().activeId);
    // Session preference is stamped only when the current active session
    // already belongs to the incoming project (a completed switch set it).
    if (
      projectIdForSession(useChatStore.getState().activeSessionId ?? "") ===
      projectRuntime.id
    ) {
      setSessionPreferences(useChatStore.getState().activeSessionId ?? "", {
        modelId: model,
      });
    }
    // Direct store write — NOT setSelectedModelId: that action mirrors into
    // the active project AND persists to live.getWorkspaceRoot(), which
    // during a switch still points at the OUTGOING project's live bridge.
    // Persisting there overwrote the outgoing project's saved model with
    // the incoming one — the exact bug this restore path must not
    // reintroduce.
    useChatStore.setState({ selectedModelId: model });
    // Only the visible project changes the legacy global presentation
    // selection; the captured project value remains independently stable.
    useAgentsStore.getState().setRoot(root);
  }, [isActive, prefsHydrated, explorerRoot, projectModelIds, prefDefaultModel]);

  // ── Session flip + live-bridge activation (was the live effect's
  //    startTransition'd activate()) ─────────────────────────────────────────
  useEffect(() => {
    if (!isActive || !projectRuntime) return;
    // startTransition: these GLOBAL chatStore writes re-render every
    // useChatStore subscriber app-wide. Deferring them out of the
    // visibility-flip paint keeps the project switch from blocking the
    // frame (the switch itself is what the user sees).
    const activate = () => {
      setActiveProjectRuntime(projectRuntime);
      setWorkspaceEnv(projectRuntime.env);
      const savedSession = getProjectActiveSession(projectRuntime.id);
      if (savedSession && savedSession !== useChatStore.getState().activeSessionId) {
        useChatStore.getState().switchSession(savedSession);
      }
      // RESTORE the incoming project's captured model — never mirror the
      // outgoing project's global selection into it (the old
      // setProjectModel(selectedModelId) captured A's model on top of B's
      // on every A→B switch, then re-restored it as if it were B's).
      const restored = getProjectModel(projectRuntime.id);
      setProjectModel(projectRuntime.id, restored, useAgentsStore.getState().activeId);
      onActivateLive();
    };
    startTransition(activate);
  }, [isActive]);

  // ── Session stamp: the global active id briefly names the OUTGOING
  //    project's chat on a flip — never stamp that id onto this project. ──
  const activeChatSessionId = useChatStore((s) => s.activeSessionId);
  useEffect(() => {
    if (!isActive || !activeChatSessionId || !projectRuntime) return;
    if (projectIdForSession(activeChatSessionId) !== projectRuntime.id) return;
    setSessionPreferences(activeChatSessionId, { projectId: projectRuntime.id });
    setProjectActiveSession(projectRuntime.id, activeChatSessionId);
  }, [isActive, projectRuntime?.id, activeChatSessionId]);

  // ── Hydration bootstrap (sessions, agents, skills, MCP, env probe) ───────
  useEffect(() => {
    if (!isActive || !launchCwdResolved || !projectRuntime) return;
    const root = explorerRoot ?? launchCwd ?? home ?? null;
    void hydrateSessions(root, projectRuntime);
    void useAgentsStore.getState().hydrate();
    void useSkillsStore.getState().hydrate(root);
    // Project-scope skills re-scan on activation (global scans once).
    void refreshProjectSkills(root);
    void useMcpStore.getState().hydrate();
    // Fire the env probe in the background — the first agent turn's <env>
    // block reads it from cache (verified shell + installed tool list).
    void import("@/modules/ai/lib/transport").then((m) => m.fetchEnvInventory());
    // Seed the model catalog immediately (disk cache first, no key needed)
    // so a restored per-project model resolves instead of hitting the
    // synthetic "Unknown model" fallback before the picker ever mounts.
    void import("@/modules/ai/store/openrouterModelsStore").then((m) =>
      m.useOpenRouterModelsStore.getState().fetch(),
    );
  }, [isActive, launchCwdResolved, explorerRoot, launchCwd, home]);

  // ── Assistant bridge / reminder scheduler (main-window surfaces) ────────
  const assistantClaimUnlisten = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!isActive) return;
    void import("@/modules/assistant")
      .then(async ({ startAssistantBridge, reclaimAssistantEvents, onAssistantClaimRequested }) => {
        assistantClaimUnlisten.current = await onAssistantClaimRequested(() => {
          void reclaimAssistantEvents();
        });
        const r = await startAssistantBridge();
        if (!r.ok && r.error && r.error !== "assistant disabled") {
          console.warn("[kai:assistant] bridge not started:", r.error);
        }
        // Bridge may already be running (started from Settings) — take over
        // delivery either way.
        if (r.ok) await reclaimAssistantEvents();
        // Project monitor: bound projects ping the owner on replies /
        // approvals and mirror /tell replies. Installs with the delivery
        // ownership, in the long-lived main window only.
        if (r.ok) {
          const { installTelegramProjectMonitor } = await import("@/modules/assistant/projectBridge");
          installTelegramProjectMonitor();
        }
        // Long-term reminder scheduler (passive, restart-safe): boot
        // catch-up + Rust-heartbeat tick. The main window is the
        // long-lived surface and the process is shared — one scheduler.
        {
          const { startReminderScheduler } = await import("@/modules/ai/lib/reminders");
          void startReminderScheduler();
        }
      })
      .catch((e) => console.warn("[kai:assistant] bridge import failed:", e));
    return () => {
      assistantClaimUnlisten.current?.();
      assistantClaimUnlisten.current = null;
    };
  }, [isActive]);

  return null;
}
