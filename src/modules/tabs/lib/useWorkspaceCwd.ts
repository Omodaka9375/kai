import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Tab } from "./useTabs";

type Result = {
  explorerRoot: string | null;
  inheritedCwdForNewTab: () => string | undefined;
};

/**
 * Derive the workspace root and inherited cwd for new tabs.
 *
 * The workspace root is NOT the active terminal's cwd — that changes on
 * every `cd`. Instead we track the initial project root from the first
 * `resetWorkspace` call (which fires at launch and on File > Open Project).
 * Subsequent terminal `cd` calls do NOT update explorerRoot.
 */
export function useWorkspaceCwd(
  activeTab: Tab | undefined,
  tabs: Tab[],
  home: string | null,
): Result {
  // Explicit root set by resetWorkspace. Undefined until first call.
  const [explicitRoot, setExplicitRoot] = useState<string | undefined>();
  // Track last terminal cwd for inheritedCwdForNewTab.
  const lastTerminalCwd = useRef<string | null>(null);

  useEffect(() => {
    if (activeTab?.kind === "terminal" && activeTab.cwd) {
      lastTerminalCwd.current = activeTab.cwd;
    }
  }, [activeTab]);

  // On launch, resetWorkspace fires with null/undefined → fall back to
  // the first terminal's cwd (the project dir opened). Once set, stays
  // stable until the next resetWorkspace call.
  //
  // This must happen inside the resetWorkspace callback flow, not in a
  // useMemo reacting to tabs, because tabs may already have terminals
  // with stale cd'd cwds by the time we render.
  const explorerRoot = useMemo<string | null>(() => {
    if (explicitRoot) return explicitRoot;
    // Before the first resetWorkspace call: use first terminal cwd as
    // a bootstrap, or fall back to home.
    if (explicitRoot === undefined) {
      const first = tabs.find((t) => t.kind === "terminal" && t.cwd);
      if (first?.kind === "terminal" && first.cwd) return first.cwd;
      return home;
    }
    // explicitRoot was explicitly null → re-derive from tabs.
    const first = tabs.find((t) => t.kind === "terminal" && t.cwd);
    if (first?.kind === "terminal" && first.cwd) return first.cwd;
    return home;
  }, [explicitRoot, tabs, home]);

  const inheritedCwdForNewTab = useCallback((): string | undefined => {
    if (activeTab?.kind === "terminal" && activeTab.cwd) return activeTab.cwd;
    return lastTerminalCwd.current ?? home ?? undefined;
  }, [activeTab, home]);

  // Export the setter so App.tsx's resetWorkspace handlers can call it.
  const setRootRef = useRef(setExplicitRoot);
  setRootRef.current = setExplicitRoot;

  return {
    explorerRoot,
    inheritedCwdForNewTab,
    /** Called by resetWorkspace to lock the root. Not part of Result type — side-channel. */
    _setRoot: (cwd: string) => setRootRef.current(cwd),
  } as Result & { _setRoot: (cwd: string) => void };
}
