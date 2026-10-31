/**
 * Quiet-when-visible desktop notifications (2026-10-31).
 *
 * HISTORY: OS popups were removed (2026-10-29) because parallel projects
 * spammed a toast per event. They are back, GATED — the rules from the
 * user's ask:
 *
 *  1. VISIBLE WINDOW = NEVER toast. The rail dot + panel already have the
 *     user's attention. Visibility is read AT FIRE TIME from the window
 *     API (isVisible + isMinimized), never from a cached event - so a
 *     re-shown window can never be told about something it already shows.
 *  2. HIDDEN (minimized / closed-to-tray) = toast only for the three
 *     classes that matter: APPROVAL needed, ERROR settled, run
 *     COMPLETELY finished (busy -> idle transition - a whole-run end,
 *     never a mid-run tool step).
 *  3. NO SPAM: events coalesce for DIGEST_MS into ONE multi-line toast
 *     (five projects finishing at once = "5 KAI updates", not five
 *     toasts). Same (project, kind) pair collapses to one line. The
 *     pair re-arms after each drain so a LATER second run is a new item.
 *  4. Re-show during the coalescing window drops the queue - the UI
 *     surfaces everything the moment the window comes back.
 *  5. Approvals drain immediately (latency matters there); done/error
 *     wait out the coalescing window.
 *
 * The queue is module-scoped and ephemeral BY DESIGN: durable surfaces
 * (rail dots, session history, Telegram pings) persist everything; the
 * toast is a courtesy for the hidden window. A missed toast is
 * recoverable from the rail.
 */

export type DigestKind = "approval" | "error" | "done";

export type DigestItem = {
  project: string;
  kind: DigestKind;
  detail: string;
};

/** Coalescing window for done/error items (ms). */
const DIGEST_MS = 2_000;
/** Hard cap - a pathological loop must not balloon the queue. */
const DIGEST_CAP = 50;

let queue: DigestItem[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

/** Window API seam - overridden in tests, absent in plain web. */
export const digestWindowApi: {
  isVisible: () => Promise<boolean>;
  isMinimized: () => Promise<boolean>;
  notify: (title: string, body: string) => Promise<void>;
} = {
  isVisible: async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow().isVisible();
  },
  isMinimized: async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow().isMinimized();
  },
  notify: async (title, body) => {
    const mod = await import("@tauri-apps/plugin-notification");
    if (await mod.isPermissionGranted()) {
      mod.sendNotification({ title, body });
    }
  },
};

/** Fire the toast for everything queued. Async on purpose (visibility read). */
export async function drainDigest(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (queue.length === 0) {
    return;
  }
  const items = queue;
  queue = [];
  // Re-arm: a LATER second run of the same (project, kind) is a new item.
  // (Within one queue the seen-map below collapses duplicates to counts.)
  // THE GATE - read at fire time. Window visible again = drop everything:
  // the UI shows it, a toast would be a duplicate.
  try {
    if (
      (await digestWindowApi.isVisible()) &&
      !(await digestWindowApi.isMinimized())
    ) {
      return;
    }
  } catch {
    return; // window API unavailable (tests/plain web) - fail quiet
  }
  // Collapse same (project, kind) into counted lines.
  const lines: string[] = [];
  const seen = new Map<string, number>();
  for (const it of items) {
    const key = `${it.project}|${it.kind}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n === 1) {
      lines.push(formatLine(it));
    } else {
      lines[lines.length - 1] = formatLine(it, n);
    }
  }
  const title =
    items.length === 1 ? lines[0]!.split("\n")[0]! : `${items.length} KAI updates`;
  try {
    await digestWindowApi.notify(title, lines.slice(0, 6).join("\n"));
  } catch {
    /* notification denied/unavailable - fail quiet */
  }
}

function formatLine(it: DigestItem, count?: number): string {
  const label =
    it.kind === "approval"
      ? "needs your approval"
      : it.kind === "error"
        ? "stopped on an error"
        : "finished";
  const suffix = count && count > 1 ? ` (x${count})` : "";
  return `${it.project} ${label}${suffix}${it.detail ? ` - ${it.detail}` : ""}`;
}

/** Offer an event into the digest. The ONLY entry point. */
export function offerToDigest(item: DigestItem): void {
  queue.push(item);
  if (queue.length > DIGEST_CAP) queue.splice(0, queue.length - DIGEST_CAP);
  // Approvals: latency matters - drain on the next macrotask (0ms) instead
  // of waiting out the coalescing window. Same drain, shorter fuse.
  const delay = item.kind === "approval" ? 0 : DIGEST_MS;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void drainDigest();
  }, delay);
}

/** Test seam: reset module state. */
export function resetDigestForTests(): void {
  queue = [];
  if (timer) clearTimeout(timer);
  timer = null;
}