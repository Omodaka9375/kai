import { Alert02Icon, Globe02Icon, Loading03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  PreviewAddressBar,
  type PreviewAddressBarHandle,
} from "./PreviewAddressBar";

export type PreviewPaneHandle = {
  reload: () => void;
  focusAddressBar: () => void;
  getUrl: () => string;
};

type Props = {
  url: string;
  visible: boolean;
  onUrlChange: (url: string) => void;
  onClose?: () => void;
};

// Tear the iframe down after this much invisibility - a background dev
// server page can hold hundreds of MB inside the WebView.
const SUSPEND_AFTER_MS = 30_000;

// ── Dev-server readiness gate ──────────────────────────────────────────────
// Opening a preview right after starting a dev server raced the server's
// boot: the iframe mounted, the connection was refused, and the user had to
// refresh manually. For local URLs we now poll the server FIRST and only
// mount the iframe once it answers (a "waiting" state covers the gap).
// A no-cors fetch is the reachability probe: it REJECTS on
// connection-refused and RESOLVES (opaque response, CORS unreadable by
// design) once anything is listening - exactly the signal we need, and CSP
// connect-src already allows localhost/127.0.0.1.
const WAIT_POLL_MS = 500;
const WAIT_MAX_ATTEMPTS = 90; // ~45s of waiting before giving up

/** Hosts the CSP connect-src actually allows the webview to probe. Other
 *  local spellings (0.0.0.0, [::1]) are skipped - a CSP-blocked fetch is
 *  indistinguishable from a refused one, so they mount directly. */
function isPollableLocalHost(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

async function serverReachable(url: string): Promise<boolean> {
  try {
    // HEAD vs GET: some dev servers answer HEAD with 405 - any response
    // still proves the server is up, so no-cors GET of "/" is fine.
    await fetch(url, { mode: "no-cors", cache: "no-store" });
    return true;
  } catch {
    return false;
  }
}

type WaitPhase =
  | { kind: "mount" }
  | { kind: "waiting"; url: string }
  | { kind: "timeout"; url: string };

export const PreviewPane = forwardRef<PreviewPaneHandle, Props>(
  function PreviewPane({ url, visible, onUrlChange, onClose }, ref) {
    // `nonce` is part of the iframe `key`. Bumping it remounts the iframe,
    // which is the only reliable cross-origin reload (calling
    // contentWindow.location.reload() throws on cross-origin frames).
    const [nonce, setNonce] = useState(0);
    const [loaded, setLoaded] = useState(visible);
    const [phase, setPhase] = useState<WaitPhase>({ kind: "mount" });
    const addressRef = useRef<PreviewAddressBarHandle>(null);

    useEffect(() => {
      if (visible) {
        setLoaded(true);
        return;
      }
      const t = setTimeout(() => setLoaded(false), SUSPEND_AFTER_MS);
      return () => clearTimeout(t);
    }, [visible]);

    // Readiness gate: runs when the URL CHANGES (open + address-bar
    // submit). Manual reloads skip the gate - the user asked for this load
    // right now. Local pollable URLs poll until the dev server answers;
    // everything else (remote sites, other local spellings) mounts
    // directly, preserving the old behavior.
    useEffect(() => {
      if (!url) {
        setPhase({ kind: "mount" });
        return;
      }
      if (!isPollableLocalHost(url)) {
        setPhase({ kind: "mount" });
        return;
      }
      let alive = true;
      setPhase({ kind: "waiting", url });
      void (async () => {
        for (let attempt = 0; attempt < WAIT_MAX_ATTEMPTS; attempt++) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
          if (!alive) return;
          // eslint-disable-next-line no-await-in-loop
          if (await serverReachable(url)) {
            if (alive) setPhase({ kind: "mount" });
            return;
          }
        }
        if (alive) setPhase({ kind: "timeout", url });
      })();
      return () => {
        alive = false;
      };
    }, [url]);

    useImperativeHandle(
      ref,
      () => ({
        reload: () => {
          setLoaded(true);
          // Manual reload = explicit user intent: mount immediately,
          // skipping the readiness gate.
          setPhase({ kind: "mount" });
          setNonce((n) => n + 1);
        },
        focusAddressBar: () => addressRef.current?.focus(),
        getUrl: () => url,
      }),
      [url],
    );

    // SECURITY: only http(s) reaches the iframe. The sandbox combines
    // allow-scripts + allow-same-origin, so a frame whose URL resolves to the
    // app's own origin (tauri:, file:, javascript:, data:, blob:) would get
    // full access to the webview's __TAURI__ IPC. Anything not http(s) is
    // rendered as a blocked notice instead of a frame.
    const safeUrl = /^https?:\/\//i.test(url) ? url : "";
    const iframeSrc = safeUrl;
    const schemeBlocked = !!url && !safeUrl;
    const showXfoHint = safeUrl ? !isLocalUrl(safeUrl) : false;

    return (
      <div
        className="flex h-full w-full flex-col overflow-hidden rounded-md border border-border/60 bg-background"
        style={{
          visibility: visible ? "visible" : "hidden",
          pointerEvents: visible ? "auto" : "none",
        }}
      >
        <PreviewAddressBar
          ref={addressRef}
          url={url}
          onSubmit={onUrlChange}
          onReload={() => setNonce((n) => n + 1)}
          onClose={onClose}
        />
        {showXfoHint ? (
          <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border/60 bg-amber-500/8 px-3 text-[11px] text-amber-600 dark:text-amber-400">
            <HugeiconsIcon
              icon={Alert02Icon}
              size={12}
              strokeWidth={1.75}
              className="shrink-0"
            />
            <span className="truncate">
              Many public sites refuse to embed (X-Frame-Options). If the page
              is blank, open it externally.
            </span>
          </div>
        ) : null}
        <div
          className={
            url
              ? "relative min-h-0 flex-1 bg-white"
              : "relative min-h-0 flex-1 bg-background"
          }
        >
          {schemeBlocked ? (
            <div className="flex h-full w-full items-center justify-center px-6 text-center text-[12px] text-muted-foreground">
              This URL cannot be previewed — only http(s) pages are supported.
            </div>
          ) : url ? (
            loaded ? (
              phase.kind === "waiting" ? (
                <WaitingForServer
                  url={phase.url}
                  onOpenNow={() => {
                    // The server may answer between polls; the user can
                    // force the mount.
                    setPhase({ kind: "mount" });
                  }}
                />
              ) : phase.kind === "timeout" ? (
                <ServerNeverCameUp
                  url={phase.url}
                  onRetry={() => {
                    setPhase({ kind: "waiting", url: phase.url });
                    void serverReachable(phase.url).then((up) => {
                      if (up) setPhase({ kind: "mount" });
                    });
                  }}
                  onOpenNow={() => setPhase({ kind: "mount" })}
                />
              ) : (
                <iframe
                key={`${iframeSrc}#${nonce}`}
                src={iframeSrc}
                title="Preview"
                className="h-full w-full border-0"
                // sandbox grants the bare minimum for a dev preview: scripts,
                // same-origin (cookies/storage for the previewed app), forms,
                // popups for "open in new tab". Critically OMITS
                // `allow-top-navigation*` — without it the iframe cannot
                // navigate the parent Tauri webview to an attacker origin,
                // which would otherwise expose `window.__TAURI__` IPC.
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
                referrerPolicy="no-referrer"
                allow="clipboard-read; clipboard-write; fullscreen"
              />
              )
            ) : (
              <SuspendedState
                onReload={() => {
                  setLoaded(true);
                  setNonce((n) => n + 1);
                }}
              />
            )
          ) : (
            <EmptyState />
          )}
        </div>
      </div>
    );
  },
);

function WaitingForServer({
  url,
  onOpenNow,
}: {
  url: string;
  onOpenNow: () => void;
}) {
  const port = (() => {
    try {
      return `:${new URL(url).port}`;
    } catch {
      return "";
    }
  })();
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex size-10 items-center justify-center rounded-2xl border border-border/60 bg-card text-muted-foreground">
        <HugeiconsIcon
          icon={Loading03Icon}
          size={18}
          strokeWidth={1.5}
          className="animate-spin"
        />
      </div>
      <div className="space-y-1">
        <p className="text-[12.5px] font-medium text-foreground">
          Waiting for the dev server{port}
        </p>
        <p className="max-w-xs text-[11px] leading-relaxed text-muted-foreground">
          The page opens by itself the moment the server answers - no manual
          refresh needed.
        </p>
      </div>
      <button
        type="button"
        onClick={onOpenNow}
        className="rounded-md border border-border/60 bg-card px-3 py-1 text-[11px] hover:bg-accent/50"
      >
        Open now
      </button>
    </div>
  );
}

function ServerNeverCameUp({
  url,
  onRetry,
  onOpenNow,
}: {
  url: string;
  onRetry: () => void;
  onOpenNow: () => void;
}) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex size-10 items-center justify-center rounded-2xl border border-border/60 bg-card text-muted-foreground">
        <HugeiconsIcon icon={Alert02Icon} size={18} strokeWidth={1.5} />
      </div>
      <div className="space-y-1">
        <p className="text-[12.5px] font-medium text-foreground">
          Server is not responding
        </p>
        <p className="max-w-xs text-[11px] leading-relaxed text-muted-foreground">
          Nothing answered at <span className="font-mono">{url}</span> for
          45 seconds. Check the server is running, then retry.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-border/60 bg-card px-3 py-1 text-[11px] hover:bg-accent/50"
        >
          Retry
        </button>
        <button
          type="button"
          onClick={onOpenNow}
          className="rounded-md border border-border/60 bg-card px-3 py-1 text-[11px] hover:bg-accent/50"
        >
          Open anyway
        </button>
      </div>
    </div>
  );
}

function SuspendedState({ onReload }: { onReload: () => void }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex size-10 items-center justify-center rounded-2xl border border-border/60 bg-card text-muted-foreground">
        <HugeiconsIcon icon={Globe02Icon} size={18} strokeWidth={1.5} />
      </div>
      <div className="space-y-1">
        <p className="text-[12.5px] font-medium text-foreground">
          Preview suspended
        </p>
        <p className="max-w-xs text-[11px] leading-relaxed text-muted-foreground">
          Released to free memory after sitting in the background.
        </p>
      </div>
      <button
        type="button"
        onClick={onReload}
        className="rounded-md border border-border/60 bg-card px-3 py-1 text-[11px] hover:bg-accent/50"
      >
        Reload
      </button>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl border border-border/60 bg-card text-muted-foreground">
        <HugeiconsIcon icon={Globe02Icon} size={20} strokeWidth={1.5} />
      </div>
      <div className="space-y-1.5">
        <p className="text-sm font-medium text-foreground">
          Nothing to preview yet
        </p>
        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
          Type a URL above, or open the{" "}
          <span className="rounded bg-muted px-1 py-0.5 font-mono text-[10.5px]">
            Ports
          </span>{" "}
          dropdown to jump straight to your running dev server. Public sites
          often block embedding — open them in your browser via the link icon
          if you see a blank page.
        </p>
      </div>
    </div>
  );
}

function isLocalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname;
    return (
      h === "localhost" ||
      h === "127.0.0.1" ||
      h === "0.0.0.0" ||
      h === "*********" ||
      h === "******" ||
      h === "[::1]" ||
      h.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}
