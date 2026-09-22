import { getVersion } from "@tauri-apps/api/app";
import { invoke, Channel } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useState } from "react";
import { IS_LINUX } from "@/lib/platform";
import { getUpdaterLastCheck, setUpdaterLastCheck } from "@/modules/settings/store";

const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const GITHUB_LATEST_RELEASE =
  "https://api.github.com/repos/Omodaka9375/kai/releases/latest";

export interface ManualUpdateInfo {
  version: string;
  currentVersion: string;
  body: string;
  releaseUrl: string;
}

export type UpdaterStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "uptodate" }
  | { kind: "available"; update: Update }
  | { kind: "manual-available"; info: ManualUpdateInfo }
  | { kind: "downloading"; downloaded: number; contentLength: number | null }
  | { kind: "ready" }
  | { kind: "error"; message: string };

function parseVersion(v: string): number[] {
  return v
    .replace(/^v/, "")
    .split("-")[0]
    .split(".")
    .map((p) => Number.parseInt(p, 10) || 0);
}

function isNewer(remote: string, current: string): boolean {
  const a = parseVersion(remote);
  const b = parseVersion(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function checkLinuxRelease(): Promise<ManualUpdateInfo | null> {
  const [current, res] = await Promise.all([
    getVersion(),
    fetch(GITHUB_LATEST_RELEASE, {
      headers: { Accept: "application/vnd.github+json" },
    }),
  ]);
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}`);
  }
  const data = (await res.json()) as {
    tag_name: string;
    body?: string;
    html_url: string;
  };
  const remote = data.tag_name.replace(/^v/, "");
  if (!isNewer(remote, current)) return null;
  return {
    version: remote,
    currentVersion: current,
    body: data.body ?? "",
    releaseUrl: data.html_url,
  };
}

interface Options {
  /** Skip the time-based throttle on automatic startup checks. */
  manual?: boolean;
}

interface HookOptions {
  /** When false, the hook does not run an automatic check on mount. */
  autoCheck?: boolean;
}

export function useUpdater({ autoCheck = true }: HookOptions = {}) {
  const [status, setStatus] = useState<UpdaterStatus>({ kind: "idle" });

  const runCheck = useCallback(async ({ manual }: Options = {}) => {
    if (!manual) {
      const last = await getUpdaterLastCheck();
      if (Date.now() - last < CHECK_INTERVAL_MS) return;
    }
    setStatus({ kind: "checking" });
    try {
      if (IS_LINUX) {
        const info = await checkLinuxRelease();
        if (info) {
          setStatus({ kind: "manual-available", info });
        } else {
          await setUpdaterLastCheck(Date.now());
          setStatus({ kind: "uptodate" });
        }
        return;
      }
      const update = await check();
      if (update) {
        setStatus({ kind: "available", update });
      } else {
        await setUpdaterLastCheck(Date.now());
        setStatus({ kind: "uptodate" });
      }
    } catch (err) {
      setStatus({ kind: "error", message: String(err) });
    }
  }, []);

  const install = useCallback(async () => {
    if (status.kind !== "available") return;
    let total: number | null = null;
    let downloaded = 0;
    setStatus({ kind: "downloading", downloaded: 0, contentLength: null });
    try {
      // Custom command (not update.downloadAndInstall): the Rust side
      // attaches on_before_exit to disarm the process-wide kill-on-close
      // job before the installer is spawned — without it, the app's exit
      // kills the inherited-job installer and the update never lands
      // (broke 1.3.6 → 1.3.7 in-app updates on Windows).
      await invoke("update_install", {
        onEvent: new Channel<{
          event: "Started" | "Progress" | "Finished";
          data: { contentLength?: number | null; chunkLength?: number };
        }>((msg) => {
          if (msg.event === "Started") {
            total = msg.data.contentLength ?? null;
            setStatus({ kind: "downloading", downloaded: 0, contentLength: total });
          } else if (msg.event === "Progress") {
            downloaded += msg.data.chunkLength ?? 0;
            setStatus({ kind: "downloading", downloaded, contentLength: total });
          } else if (msg.event === "Finished") {
            setStatus({ kind: "ready" });
          }
        }),
      });
      await relaunch();
    } catch (err) {
      setStatus({ kind: "error", message: String(err) });
    }
  }, [status]);

  const dismiss = useCallback(() => {
    setStatus({ kind: "idle" });
  }, []);

  useEffect(() => {
    if (!autoCheck) return;
    void runCheck();
  }, [autoCheck, runCheck]);

  return { status, check: runCheck, install, dismiss };
}
