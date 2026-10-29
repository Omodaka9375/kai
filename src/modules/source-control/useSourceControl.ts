import {
  native,
  type GitChangedFile,
  type GitRepoInfo,
  type GitStatusSnapshot,
} from "@/modules/ai/lib/native";
import { useWorkspaceEnvStore, useProjectRuntime, workspaceScopeKey } from "@/modules/workspace";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const AUTO_FETCH_THROTTLE_MS = 5 * 60_000;
const AUTO_FETCH_LRU_LIMIT = 16;
/** How long a context path must stay stable before it drives a git refresh.
 * Tab switches and OSC 7 cwd arrivals flicker the context (A → B → A in
 * one or two frames); every cross-repo change blanks the panel
 * synchronously — the full-panel blink. */
const CONTEXT_SETTLE_MS = 200;

// ── Content equality (identity-preserving refresh) ──────────────────────────
//
// Every window focus triggers a refresh (400ms-debounced). The refreshed
// snapshot is CONTENT-IDENTICAL in the common case, but it used to replace
// repo/status objects unconditionally — new identities churned the summary
// object, the panel reconcile effect, staged/unstaged entry memos and the
// whole virtualized row list, repainting the panel on every focus for zero
// visual change (the "focus blink"). These helpers let setState KEEP the
// previous object identity when the content hasn't changed.

function changedFileEquals(a: GitChangedFile, b: GitChangedFile): boolean {
  return (
    a.path === b.path &&
    a.originalPath === b.originalPath &&
    a.indexStatus === b.indexStatus &&
    a.worktreeStatus === b.worktreeStatus &&
    a.staged === b.staged &&
    a.unstaged === b.unstaged &&
    a.untracked === b.untracked &&
    a.statusLabel === b.statusLabel
  );
}

function statusEqual(a: GitStatusSnapshot, b: GitStatusSnapshot): boolean {
  if (
    a.repoRoot !== b.repoRoot ||
    a.branch !== b.branch ||
    a.upstream !== b.upstream ||
    a.ahead !== b.ahead ||
    a.behind !== b.behind ||
    a.isDetached !== b.isDetached ||
    a.defaultBranch !== b.defaultBranch ||
    a.truncated !== b.truncated
  ) {
    return false;
  }
  const fa = a.changedFiles;
  const fb = b.changedFiles;
  if (fa.length !== fb.length) return false;
  for (let i = 0; i < fa.length; i++) {
    if (!changedFileEquals(fa[i], fb[i])) return false;
  }
  return true;
}

function repoEqual(a: GitRepoInfo, b: GitRepoInfo): boolean {
  return (
    a.repoRoot === b.repoRoot &&
    a.branch === b.branch &&
    a.upstream === b.upstream &&
    a.isDetached === b.isDetached
  );
}

export type SourceControlRefreshMode = "auto" | "always" | "never";
export type SourceControlRemoteAction = "fetch" | "pull" | "push";
export type SourceControlRemoteActionMode =
  | "contextual"
  | SourceControlRemoteAction;

export type SourceControlRemoteActionResult = {
  ok: boolean;
  action: SourceControlRemoteAction | null;
  error?: string;
  blocked?: "diverged" | "missing-upstream" | "no-repo";
  /** Human-readable outcome for the panel footer (e.g. "Pulled 3 commits
   *  (fast-forward)" or "Branch is up to date"). Null when blocked/errored. */
  message?: string;
};

export type SourceControlSummary = {
  repo: GitRepoInfo | null;
  status: GitStatusSnapshot | null;
  changedCount: number;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasRepo: boolean;
  isLoading: boolean;
  /** A refresh or background remote sync is in flight. Unlike `isLoading`
   *  (which blanks the panel on first load), this survives alongside already-
   *  shown data so the header can show a syncing indicator. */
  isSyncing: boolean;
  localError: string | null;
  busyAction: SourceControlRemoteAction | null;
  lastRemoteError: string | null;
  applyStatus: (
    updater: (status: GitStatusSnapshot) => GitStatusSnapshot,
  ) => void;
  refresh: (options?: {
    remote?: SourceControlRefreshMode;
    mutation?: boolean;
  }) => Promise<void>;
  /** Refresh + force a network fetch (bypasses the auto-fetch throttle).
   *  This is the manual-refresh semantic: the user explicitly wants to know
   *  what's upstream RIGHT NOW. Resolves when done. */
  fetchNow: () => Promise<void>;
  runRemoteAction: (
    mode?: SourceControlRemoteActionMode,
  ) => Promise<SourceControlRemoteActionResult>;
};

export type SourceControlRemoteIndicator = {
  visible: boolean;
  label: string;
  title: string;
  disabled: boolean;
  action: SourceControlRemoteAction | null;
};

type SourceControlSummaryState = {
  repo: GitRepoInfo | null;
  status: GitStatusSnapshot | null;
  hasRepo: boolean;
  isLoading: boolean;
  isSyncing: boolean;
  localError: string | null;
  busyAction: SourceControlRemoteAction | null;
  lastRemoteError: string | null;
};

function normalizeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Unknown source control error";
}

function getContextualAction(
  status: GitStatusSnapshot | null,
): SourceControlRemoteAction | null {
  // No upstream + local commits ahead → publish the branch (push -u via Rust).
  // With no upstream and nothing to publish, fetch keeps the pill useful.
  if (!status) return null;
  if (!status.upstream) return status.ahead > 0 ? "push" : "fetch";
  // When diverged, the user should pull (which will merge) to resolve.
  if (status.ahead > 0 && status.behind > 0) return "pull";
  if (status.behind > 0) return "pull";
  if (status.ahead > 0) return "push";
  return "fetch";
}

export function getSourceControlRemoteIndicator(
  summary: Pick<
    SourceControlSummary,
    "hasRepo" | "upstream" | "ahead" | "behind" | "busyAction"
  >,
): SourceControlRemoteIndicator {
  if (!summary.hasRepo) {
    return { visible: false, label: "", title: "", disabled: true, action: null };
  }
  // No upstream yet: offer Publish when there are local commits to push
  // (Rust publishes via `git push -u`); otherwise hide — nothing to do.
  if (!summary.upstream) {
    if (summary.ahead > 0) {
      return {
        visible: true,
        label: "Publish branch",
        title:
          "This branch has no upstream. Pushing will create it on the remote and set up tracking (git push -u).",
        disabled: summary.busyAction !== null,
        action: "push",
      };
    }
    return { visible: false, label: "", title: "", disabled: true, action: null };
  }
  if (summary.ahead > 0 && summary.behind > 0) {
    return {
      visible: true,
      label: `↑${summary.ahead} ↓${summary.behind}`,
      title:
        "Branch has diverged — pull will merge. Merge conflicts may need manual resolution.",
      disabled: summary.busyAction !== null,
      action: "pull",
    };
  }
  if (summary.behind > 0) {
    return {
      visible: true,
      label: `↓${summary.behind}`,
      title: `Pull ${summary.behind} remote ${
        summary.behind === 1 ? "commit" : "commits"
      } with fast-forward only.`,
      disabled: summary.busyAction !== null,
      action: "pull",
    };
  }
  if (summary.ahead > 0) {
    return {
      visible: true,
      label: `↑${summary.ahead}`,
      title: `Push ${summary.ahead} local ${
        summary.ahead === 1 ? "commit" : "commits"
      }.`,
      disabled: summary.busyAction !== null,
      action: "push",
    };
  }
  return {
    visible: true,
    label: "Sync",
    title: "Fetch remote updates.",
    disabled: summary.busyAction !== null,
    action: "fetch",
  };
}

function touchAutoFetch(map: Map<string, number>, key: string): void {
  map.delete(key);
  map.set(key, Date.now());
  while (map.size > AUTO_FETCH_LRU_LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function useSourceControl(
  contextPath: string | null,
  enabled: boolean = true,
): SourceControlSummary {
  const runtime = useProjectRuntime();
  const workspaceEnv = runtime?.env ?? useWorkspaceEnvStore((s) => s.env);
  const workspaceKey = workspaceScopeKey(workspaceEnv);
  const [state, setState] = useState<SourceControlSummaryState>({
    repo: null,
    status: null,
    hasRepo: false,
    isLoading: false,
    isSyncing: false,
    localError: null,
    busyAction: null,
    lastRemoteError: null,
  });
  const stateRef = useRef(state);
  const requestIdRef = useRef(0);
  const inflightRef = useRef<Promise<void> | null>(null);
  const inflightModeRef = useRef<SourceControlRefreshMode>("never");
  const autoFetchByRepoRef = useRef(new Map<string, number>());
  const enabledRef = useRef(enabled);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    requestIdRef.current++;
    inflightRef.current = null;
    inflightModeRef.current = "never";
    autoFetchByRepoRef.current.clear();
    setState({
      repo: null,
      status: null,
      hasRepo: false,
      isLoading: false,
      isSyncing: false,
      localError: null,
      busyAction: null,
      lastRemoteError: null,
    });
  }, [workspaceKey]);

  // Debounced context switch. The raw context path flickers during tab
  // switches (active leaf cwd briefly unresolved → tab spawn cwd → real
  // leaf cwd) and OSC 7 arrivals; a cross-repo change blanks the panel
  // synchronously in doRefresh (the "different repo" branch). A path must
  // stay stable for CONTEXT_SETTLE_MS before it becomes the refresh
  // context — momentary flickers never reach git, so the panel never
  // blanks for a context it is about to switch back from.
  const [settledContextPath, setSettledContextPath] = useState(contextPath);
  useEffect(() => {
    if (contextPath === settledContextPath) return;
    const timer = window.setTimeout(
      () => setSettledContextPath(contextPath),
      CONTEXT_SETTLE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [contextPath, settledContextPath]);

  const applyStatus = useCallback(
    (updater: (status: GitStatusSnapshot) => GitStatusSnapshot) => {
      setState((current) => {
        if (!current.status) return current;
        const next = updater(current.status);
        if (next === current.status) return current;
        return { ...current, status: next };
      });
    },
    [],
  );

  const doRefresh = useCallback(
    async (remoteMode: SourceControlRefreshMode): Promise<void> => {
      if (!enabledRef.current) return;
      const requestId = ++requestIdRef.current;

      if (!settledContextPath) {
        setState({
          repo: null,
          status: null,
          hasRepo: false,
          isLoading: false,
          isSyncing: false,
          localError: null,
          busyAction: null,
          lastRemoteError: null,
        });
        return;
      }

      const activeRoot = stateRef.current.repo?.repoRoot ?? null;
      const reusableRoot =
        activeRoot &&
        (settledContextPath === activeRoot ||
          settledContextPath.startsWith(`${activeRoot}/`))
          ? activeRoot
          : undefined;

      setState((current) => {
        // Same repo (or nothing stale to clear): keep data, flip the loading
        // flags. Different repo: blank the PREVIOUS project's data NOW so
        // the panel and header never render the old branch/status under the
        // new context while the new snapshot loads.
        if (reusableRoot || !(current.repo || current.status || current.hasRepo)) {
          // Refreshing in place (same repo, data already on screen): the
          // panel keeps rendering the current snapshot, so isLoading (which
          // gates the "Loading repository" center) must not flip, and
          // isSyncing means a REMOTE fetch is in flight — decided after the
          // snapshot lands, not here. Preserving the state identity avoids
          // re-rendering the panel when nothing has changed (focus blink).
          if (
            reusableRoot &&
            current.repo &&
            current.status &&
            !current.isLoading &&
            !current.localError
          ) {
            return current;
          }
          return { ...current, isLoading: true, isSyncing: true, localError: null };
        }
        return {
          repo: null,
          status: null,
          hasRepo: false,
          isLoading: true,
          isSyncing: true,
          localError: null,
          busyAction: current.busyAction,
          lastRemoteError: current.lastRemoteError,
        };
      });

      try {
        let repo: GitRepoInfo | null;
        let status: GitStatusSnapshot | null;

        if (reusableRoot) {
          try {
            repo = stateRef.current.repo ?? null;
            status = await native.gitStatus(reusableRoot);
            if (requestId !== requestIdRef.current) return;
            if (!repo || repo.repoRoot !== reusableRoot) {
              repo = {
                repoRoot: reusableRoot,
                branch: status.branch,
                upstream: status.upstream,
                isDetached: status.isDetached,
              };
            }
          } catch {
            const snapshot = await native.gitPanelSnapshot(settledContextPath);
            if (requestId !== requestIdRef.current) return;
            if (!snapshot.repo) {
              setState((current) => ({
                ...current,
                repo: null,
                status: null,
                hasRepo: false,
                isLoading: false,
                isSyncing: false,
                localError: null,
              }));
              return;
            }
            repo = snapshot.repo;
            status = snapshot.status ?? null;
          }
        } else {
          const snapshot = await native.gitPanelSnapshot(settledContextPath);
          if (requestId !== requestIdRef.current) return;
          if (!snapshot.repo) {
            setState((current) => ({
              ...current,
              repo: null,
              status: null,
              hasRepo: false,
              isLoading: false,
              isSyncing: false,
              localError: null,
            }));
            return;
          }
          repo = snapshot.repo;
          status = snapshot.status ?? null;
        }

        if (!repo) {
          setState((current) => ({
            ...current,
            repo: null,
            status: null,
            hasRepo: false,
            isLoading: false,
            isSyncing: false,
            localError: null,
          }));
          return;
        }

        const shouldAutoFetch =
          !!repo.upstream &&
          remoteMode !== "never" &&
          (remoteMode === "always" ||
            Date.now() -
              (autoFetchByRepoRef.current.get(repo.repoRoot) ?? 0) >=
              AUTO_FETCH_THROTTLE_MS);

        // Surface the LOCAL snapshot immediately — the first paint must not
        // wait on the network. With an upstream, a background fetch follows
        // and refreshes ahead/behind when it lands (isSyncing stays true so
        // the header shows a syncing indicator meanwhile).
        if (requestId !== requestIdRef.current) return;
        setState((current) => {
          const nextRepo: GitRepoInfo = {
            ...repo,
            // `status` is authoritative for identity fields — `repo` is loaded
            // once and cached per root (reusableRoot path), so its `branch`/
            // `upstream`/`isDetached` can be one switch behind after a branch
            // switch. Deriving them from the fresh status snapshot prevents
            // the header pill (which renders `repo.branch` downstream) from
            // showing the OLD branch for the gap between this status landing
            // and the next full snapshot. Null status (snapshot path) keeps
            // the repo's own values.
            branch: status?.branch ?? repo.branch,
            upstream: status?.upstream ?? repo.upstream,
            isDetached: status?.isDetached ?? repo.isDetached,
          };
          // Identity-preserving fast path: the refresh that lands
          // content-identical data (the common case — every window focus)
          // must not churn repo/status identities. Downstream consumers
          // (summary → panel reconcile effect → entry/row memos → the
          // virtualized list) key off object identity, so churn here
          // repainted the whole panel with zero visual change.
          const sameRepo = current.repo != null && repoEqual(current.repo, nextRepo);
          const sameStatus =
            current.status != null && status != null && statusEqual(current.status, status);
          if (
            sameRepo &&
            sameStatus &&
            current.hasRepo &&
            !current.isLoading &&
            !current.isSyncing &&
            !shouldAutoFetch &&
            current.localError == null
          ) {
            return current;
          }
          return {
            ...current,
            // Keep the old object identity on identical content so
            // downstream memos don't recompute.
            repo: sameRepo ? current.repo : nextRepo,
            status: sameStatus ? current.status : status,
            hasRepo: true,
            isLoading: false,
            isSyncing: shouldAutoFetch,
            localError: null,
          };
        });

        if (shouldAutoFetch) {
          try {
            await native.gitFetch(repo.repoRoot);
            touchAutoFetch(autoFetchByRepoRef.current, repo.repoRoot);
            if (requestId !== requestIdRef.current) return;
            const fresh = await native.gitStatus(repo.repoRoot);
            if (requestId !== requestIdRef.current) return;
            setState((current) => ({
              ...current,
              // Keep the previous status identity when the fetch changed
              // nothing — only isSyncing clears, so no row re-render.
              status:
                current.status != null && statusEqual(current.status, fresh)
                  ? current.status
                  : fresh,
              lastRemoteError: null,
              isSyncing: false,
            }));
          } catch (error) {
            if (requestId !== requestIdRef.current) return;
            setState((current) => ({
              ...current,
              lastRemoteError: normalizeError(error),
              isSyncing: false,
            }));
          }
        }
      } catch (error) {
        if (requestId !== requestIdRef.current) return;
        setState((current) => {
          // Transient failure (index.lock contention during a commit, IPC
          // hiccup, git briefly unavailable): KEEP the last good snapshot.
          // Blank-and-error here made the whole panel blink to the error
          // state and wiped the commit message on a retry-able failure.
          // localError still surfaces (header); the panel keeps its data.
          if (current.status || current.repo) {
            return {
              ...current,
              isLoading: false,
              isSyncing: false,
              localError: normalizeError(error),
            };
          }
          return {
            repo: null,
            hasRepo: false,
            status: null,
            isLoading: false,
            isSyncing: false,
            localError: normalizeError(error),
            busyAction: current.busyAction,
            lastRemoteError: current.lastRemoteError,
          };
        });
      }
    },
    [settledContextPath, workspaceKey],
  );

  const refresh = useCallback(
    async (options?: { remote?: SourceControlRefreshMode; mutation?: boolean }) => {
      const remoteMode = options?.remote ?? "never";
      // After a mutation (commit/push/stage/unstage), any in-flight
      // refresh carries stale data from before the mutation completed.
      // Skip the dedup and force a fresh read so the panel updates
      // immediately instead of showing ghost entries for 5-10 seconds.
      if (!options?.mutation) {
        const inflight = inflightRef.current;
        if (inflight) {
          const cur = inflightModeRef.current;
          const upgrade =
            (cur === "never" && remoteMode !== "never") ||
            (cur === "auto" && remoteMode === "always");
          if (!upgrade) return inflight;
        }
      }
      inflightModeRef.current = remoteMode;
      const run = doRefresh(remoteMode).finally(() => {
        if (inflightRef.current === run) {
          inflightRef.current = null;
          inflightModeRef.current = "never";
        }
      });
      inflightRef.current = run;
      return run;
    },
    [doRefresh],
  );

  const fetchNow = useCallback(async () => {
    // Dedup: reuse an in-flight refresh unless it's already fetching — the
    // upgrade rule in refresh() promotes never→always which covers this.
    await refresh({ remote: "always" });
  }, [refresh]);

  const runRemoteAction = useCallback(
    async (
      mode: SourceControlRemoteActionMode = "contextual",
    ): Promise<SourceControlRemoteActionResult> => {
      const { repo, status } = stateRef.current;
      if (!repo || !status) {
        return { ok: false, action: null, blocked: "no-repo" };
      }
      // NOTE: no-upstream is no longer a blocker — Rust push() publishes the
      // branch (`git push -u <remote> <branch>`) when the current branch has
      // no upstream. That is the "Publish branch" flow for freshly created
      // branches, so push must go through even without an upstream.

      const action = mode === "contextual" ? getContextualAction(status) : mode;
      if (!action) {
        return { ok: false, action: null, blocked: "diverged" };
      }

      setState((current) => ({ ...current, busyAction: action }));

      try {
        let message: string;
        if (action === "fetch") {
          await native.gitFetch(repo.repoRoot);
          touchAutoFetch(autoFetchByRepoRef.current, repo.repoRoot);
          message = "Fetched remote updates";
        } else if (action === "pull") {
          // When behind but not diverged: fast-forward is safe and clean.
          // When diverged (ahead + behind): non-ff merge — `git pull` in
          // Rust handles fetch internally, so no separate fetch needed.
          const diverged = status.ahead > 0 && status.behind > 0;
          const result = diverged
            ? await native.gitPull(repo.repoRoot)
            : await native.gitPullFfOnly(repo.repoRoot);
          message = result.upToDate
            ? "Branch is up to date — nothing to pull"
            : result.mergeCommit
              ? `Pulled ${result.pulledCommits} ${
                  result.pulledCommits === 1 ? "commit" : "commits"
                } (merged as ${result.mergeCommit})`
              : `Pulled ${result.pulledCommits} ${
                  result.pulledCommits === 1 ? "commit" : "commits"
                } (fast-forward)`;
        } else {
          const result = await native.gitPush(repo.repoRoot);
          const published = !status.upstream;
          message = result.pushed
            ? published
              ? `Published ${result.branch ?? "branch"} to ${result.remote ?? "remote"} — upstream set, future pushes are one click`
              : `Pushed to ${result.remote ?? "remote"}/${result.branch ?? ""}`
            : "Push completed — nothing to push";
        }
        setState((current) => ({ ...current, lastRemoteError: null }));
        await refresh({ remote: "never", mutation: true });
        return { ok: true, action, message };
      } catch (error) {
        const message = normalizeError(error);
        setState((current) => ({ ...current, lastRemoteError: message }));
        await refresh({ remote: "never", mutation: true }).catch(() => {});
        return { ok: false, action, error: message };
      } finally {
        setState((current) => ({ ...current, busyAction: null }));
      }
    },
    [refresh],
  );

  useEffect(() => {
    if (!enabled) {
      requestIdRef.current++;
      setState({
        repo: null,
        status: null,
        hasRepo: false,
        isLoading: false,
        isSyncing: false,
        localError: null,
        busyAction: null,
        lastRemoteError: null,
      });
      return;
    }
    setState((current) => ({ ...current, lastRemoteError: null }));
    const run = () => {
      void refresh({ remote: "auto" });
    };
    const idle =
      typeof window.requestIdleCallback === "function"
        ? window.requestIdleCallback(run, { timeout: 600 })
        : (window.setTimeout(run, 0) as unknown as number);
    return () => {
      if (typeof window.cancelIdleCallback === "function") {
        try {
          window.cancelIdleCallback(idle as number);
        } catch {
          /* noop */
        }
      } else {
        window.clearTimeout(idle as number);
      }
    };
  }, [refresh, contextPath, enabled, workspaceKey]);

  useEffect(() => {
    if (!enabled) return;
    let timer = 0;
    const onFocus = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = 0;
        void refresh({ remote: "auto" });
      }, 400);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      if (timer) window.clearTimeout(timer);
    };
  }, [refresh, enabled]);

  return useMemo<SourceControlSummary>(
    () => ({
      repo: state.repo,
      status: state.status,
      changedCount: state.status?.changedFiles.length ?? 0,
      upstream: state.status?.upstream ?? state.repo?.upstream ?? null,
      ahead: state.status?.ahead ?? 0,
      behind: state.status?.behind ?? 0,
      hasRepo: state.hasRepo,
      isLoading: state.isLoading,
      isSyncing: state.isSyncing,
      localError: state.localError,
      busyAction: state.busyAction,
      lastRemoteError: state.lastRemoteError,
      applyStatus,
      refresh,
      fetchNow,
      runRemoteAction,
    }),
    [state, applyStatus, refresh, fetchNow, runRemoteAction],
  );
}
