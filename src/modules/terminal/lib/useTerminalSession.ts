import { ensureMonoFontsLoaded } from "@/lib/fonts";
import { IS_WINDOWS } from "@/lib/platform";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { SearchAddon } from "@xterm/addon-search";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { DormantRing } from "./dormantRing";
import { feedText as feedErrorDetector, resetDetector } from "./errorDetector";
import {
  createShellIntegrationState,
  registerCwdHandler,
  registerPromptTracker,
} from "./osc-handlers";
import { openPty, type PtySession } from "./pty-bridge";
import {
  acquireSlot,
  applyFontSize,
  applyTheme as applyPoolTheme,
  applyScrollback,
  applyWebglPreference,
  configureRendererPool,
  focusSlot,
  getSlotForLeaf,
  releaseSlot,
  setSlotFocused,
} from "./rendererPool";

type Callbacks = {
  onSearchReady?: (addon: SearchAddon) => void;
  onExit?: (code: number) => void;
  onCwd?: (cwd: string) => void;
};

type Session = {
  pty: PtySession | null;
  ptyOpening: boolean;
  initialCwd: string | undefined;
  lastCwd: string | null;
  pendingExit: number | null;
  shellExited: boolean;
  callbacks: Callbacks;
  visibleNow: boolean;
  focusedNow: boolean;
  disposed: boolean;
  ready: Promise<void>;
  cols: number;
  rows: number;
  container: HTMLDivElement | null;
  snapshot: string | null;
  searchQuery: string | null;
  dormantRing: DormantRing;
  hasSlot: boolean;
  /** Set to true once the PTY has delivered at least one byte of output. */
  receivedOutput: boolean;
  /** Pending nudge setTimeout handles — cleared on dispose. */
  nudgeTimers: ReturnType<typeof setTimeout>[];
};

const sessions = new Map<number, Session>();

// Upper bound on waiting for the font pipeline before binding the renderer
// slot. A stalled `document.fonts.ready` (heavy first paint with the AI window
// visible / many chat sessions) must not leave the terminal permanently
// unbound. On timeout the slot binds with the current fallback font metrics
// and xterm re-fits on the next resize.
const FONT_READY_TIMEOUT_MS = 2500;

// The renderer bind retries while the container ref is still unpopulated.
// Reopening a project (`resetWorkspace`) tears down and remounts the whole tab
// subtree, so the font-ready `.then` can land before the new container commits.
const ATTACH_RETRY_MS = 50;
const ATTACH_RETRY_BOUND = 40;

configureRendererPool({
  resolveLeaf(leafId) {
    const s = sessions.get(leafId);
    if (!s) return null;
    return {
      writeToPty: (data) => {
        s.pty?.write(data);
      },
      resizePty: (cols, rows) => {
        s.cols = cols;
        s.rows = rows;
        s.pty?.resize(cols, rows);
      },
    };
  },
  evictLeaf(leafId) {
    const s = sessions.get(leafId);
    if (!s) return;
    unbindLeafFromSlot(leafId, s);
  },
  isLeafFocused(leafId) {
    const s = sessions.get(leafId);
    return !!s && s.visibleNow && s.focusedNow;
  },
});

function ensureSession(leafId: number, initialCwd?: string): Session {
  const existing = sessions.get(leafId);
  if (existing) return existing;

  const session: Session = {
    pty: null,
    ptyOpening: false,
    initialCwd,
    lastCwd: null,
    pendingExit: null,
    shellExited: false,
    callbacks: {},
    visibleNow: false,
    focusedNow: false,
    disposed: false,
    ready: Promise.resolve(),
    cols: 0,
    rows: 0,
    container: null,
    snapshot: null,
    searchQuery: null,
    dormantRing: new DormantRing(),
    hasSlot: false,
    receivedOutput: false,
    nudgeTimers: [],
  };
  sessions.set(leafId, session);

  session.ready = (async () => {
    await Promise.race([
      (async () => {
        await ensureMonoFontsLoaded();
        await document.fonts.ready;
      })(),
      new Promise<void>((resolve) => setTimeout(resolve, FONT_READY_TIMEOUT_MS)),
    ]);
  })();

  return session;
}

const textDecoder = new TextDecoder("utf-8", { fatal: false });

function deliverPtyBytes(leafId: number, bytes: Uint8Array): void {
  const s = sessions.get(leafId);
  if (!s) return;
  const slot = getSlotForLeaf(leafId);
  // Only count output as "received" once it reaches a live renderer. Bytes that
  // merely land in the dormant ring have not been shown to the user yet — and
  // the nudge timers below are the recovery path for a session whose slot never
  // bound. Marking the flag here would silence it and leave a blank pane
  // permanently (seen on project reopen, where the tab subtree is remounted).
  if (slot) s.receivedOutput = true;
  if (slot) slot.term.write(bytes);
  else s.dormantRing.push(bytes);
  // Feed to error detector (skip private terminals).
  if (!s.disposed) feedErrorDetector(textDecoder.decode(bytes, { stream: true }));
}

/**
 * Open a PTY with a single automatic retry on failure.
 *
 * ConPTY races, transient I/O errors, and cwd permission issues can
 * cause the first spawn to fail. A 1-second retry often resolves it.
 * On the second failure, write the error into the terminal so the
 * user knows the shell didn't start — no more silent dead terminals.
 */
function openPtySession(
  leafId: number,
  s: Session,
  cwd: string | undefined,
  attempt: number,
): void {
  openPtyForSession(leafId, s, cwd)
    .then((pty) => {
      s.ptyOpening = false;
      if (s.disposed) {
        pty.close();
        return;
      }
      s.pty = pty;
      s.receivedOutput = false;
      if (s.cols > 0 && s.rows > 0) pty.resize(s.cols, s.rows);

      // In React strict mode the .then() may fire after attachSession
      // called bindLeafToSlot but before the React re-mount wired the
      // container. Re-bind if needed.
      if (s.container && !s.hasSlot) bindLeafToSlot(leafId, s);

      // Prompt nudge: ConPTY shells can render the initial prompt
      // before the frontend wires the output channel. Some shells
      // (pwsh with Oh-My-Posh + heavy modules) take 2-3 seconds.
      const nudge = (ms: number, action: () => void) => {
        const id = setTimeout(() => {
          s.nudgeTimers = s.nudgeTimers.filter((t) => t !== id);
          if (!s.receivedOutput && !s.disposed && s.pty === pty) action();
        }, ms);
        s.nudgeTimers.push(id);
      };
      nudge(500, () => {
        void pty.resize(s.cols || 80, s.rows || 24);
      });
      nudge(3000, () => {
        void pty.write("\r");
      });
    })
    .catch((e) => {
      s.ptyOpening = false;
      console.error("[Kai] openPty failed (attempt %d):", attempt, e);
      if (attempt < 1 && !s.disposed) {
        s.ptyOpening = true;
        setTimeout(() => {
          if (s.disposed) return;
          openPtySession(leafId, s, s.initialCwd, attempt + 1);
        }, 1000);
      } else if (!s.disposed && s.container) {
        // Show error in the terminal — no more silent dead panes.
        const slot = getSlotForLeaf(leafId);
        if (slot) {
          slot.term.write(
            `\r\n\x1b[31mShell failed to start:\x1b[0m ${String(e)}\r\n`,
          );
        }
      }
    });
}

/** Start the PTY shell unless it is already running, starting, or dead. */
function startPtyIfNeeded(leafId: number, s: Session): void {
  if (s.disposed || s.shellExited || s.pty || s.ptyOpening) return;
  s.ptyOpening = true;
  openPtySession(leafId, s, s.initialCwd, 0);
}

async function openPtyForSession(
  leafId: number,
  s: Session,
  cwd: string | undefined,
): Promise<PtySession> {
  const startCols = s.cols > 0 ? s.cols : 80;
  const startRows = s.rows > 0 ? s.rows : 24;
  // Read shell pref. If the store hasn't hydrated yet (first tab on launch),
  // the default is "auto" which lets Rust auto-detect. The user's saved
  // preference takes effect once hydration completes (subsequent tabs).
  const pref = usePreferencesStore.getState();
  const shell = IS_WINDOWS ? pref.defaultShell : undefined;
  return openPty(
    startCols,
    startRows,
    {
      onData: (bytes) => deliverPtyBytes(leafId, bytes),
      onExit: (code) => {
        s.shellExited = true;
        s.pty = null;
        const slot = getSlotForLeaf(leafId);
        if (slot) slot.term.options.disableStdin = true;
        if (s.callbacks.onExit) s.callbacks.onExit(code);
        else s.pendingExit = code;
      },
    },
    cwd,
    shell,
  );
}

function bindLeafToSlot(leafId: number, s: Session): void {
  if (!s.container) return;
  acquireSlot({
    leafId,
    container: s.container,
    snapshot: s.snapshot,
    drainRing: (write) => s.dormantRing.drain(write),
    shellExited: s.shellExited,
    searchQuery: s.searchQuery,
    cols: s.cols,
    rows: s.rows,
    onScopeChange: (cols, rows) => {
      s.cols = cols;
      s.rows = rows;
    },
    registerOsc: (term) => {
      // Shared in-command flag — see osc-handlers.ts. The prompt tracker
      // flips it on OSC 133 B/C/D/A; the cwd handler reads it to ignore OSC
      // 7 emitted by untrusted command output (remote SSH, `cat` of an
      // attacker file, etc.).
      const shellState = createShellIntegrationState();
      const prompt = registerPromptTracker(term, shellState);
      const cwd = registerCwdHandler(
        term,
        (next) => {
          if (s.lastCwd === next) return;
          s.lastCwd = next;
          s.callbacks.onCwd?.(next);
        },
        shellState,
      );
      return [prompt.dispose, cwd];
    },
    onSearchReady: (addon) => s.callbacks.onSearchReady?.(addon),
  });
  s.snapshot = null;
  s.hasSlot = true;
  if (s.lastCwd !== null) s.callbacks.onCwd?.(s.lastCwd);
  if (s.pendingExit !== null) {
    const code = s.pendingExit;
    s.pendingExit = null;
    s.callbacks.onExit?.(code);
  }
}

function unbindLeafFromSlot(leafId: number, s: Session): void {
  if (!s.hasSlot) return;
  const out = releaseSlot(leafId);
  if (out) {
    s.snapshot = out.snapshot;
    if (out.cols > 0) s.cols = out.cols;
    if (out.rows > 0) s.rows = out.rows;
  }
  s.hasSlot = false;
}

function attachSession(
  leafId: number,
  container: HTMLDivElement,
  callbacks: Callbacks,
): void {
  const s = sessions.get(leafId);
  if (!s || s.disposed) return;
  s.callbacks = callbacks;
  s.container = container;

  if (s.visibleNow && !s.hasSlot) bindLeafToSlot(leafId, s);

  startPtyIfNeeded(leafId, s);
}

function detachSession(leafId: number): void {
  const s = sessions.get(leafId);
  if (!s) return;
  unbindLeafFromSlot(leafId, s);
  s.callbacks = {};
  s.container = null;
}

export async function respawnSession(
  leafId: number,
  cwd?: string,
): Promise<void> {
  const s = sessions.get(leafId);
  if (!s || s.disposed) return;
  s.pty?.close();
  s.pty = null;
  s.snapshot = null;
  s.dormantRing = new DormantRing();
  s.shellExited = false;
  s.pendingExit = null;

  const slot = getSlotForLeaf(leafId);
  if (slot) {
    slot.term.options.disableStdin = false;
    slot.term.clear();
    slot.term.reset();
  }

  s.ptyOpening = true;
  let pty: PtySession;
  try {
    pty = await openPtyForSession(leafId, s, cwd ?? s.initialCwd);
  } catch (e) {
    s.ptyOpening = false;
    console.error("[Kai] respawn openPty failed:", e);
    if (slot) {
      slot.term.write(
        `\r\n\x1b[31mShell failed to start:\x1b[0m ${String(e)}\r\n`,
      );
    }
    return;
  }
  s.ptyOpening = false;
  if (s.disposed) {
    pty.close();
    return;
  }
  s.pty = pty;
  if (s.cols > 0 && s.rows > 0) pty.resize(s.cols, s.rows);
}

export function disposeSession(leafId: number): void {
  const s = sessions.get(leafId);
  if (!s) return;
  s.disposed = true;
  for (const t of s.nudgeTimers) clearTimeout(t);
  s.nudgeTimers = [];
  resetDetector();
  unbindLeafFromSlot(leafId, s);
  s.snapshot = null;
  s.pty?.close();
  s.pty = null;
  sessions.delete(leafId);
}

type Options = {
  leafId: number;
  container: React.RefObject<HTMLDivElement | null>;
  visible: boolean;
  focused?: boolean;
  initialCwd?: string;
  onSearchReady?: (addon: SearchAddon) => void;
  onExit?: (code: number) => void;
  onCwd?: (cwd: string) => void;
};

export function useTerminalSession({
  leafId,
  container,
  visible,
  focused = true,
  initialCwd,
  onSearchReady,
  onExit,
  onCwd,
}: Options) {
  const cbRef = useRef({ onSearchReady, onExit, onCwd });
  cbRef.current = { onSearchReady, onExit, onCwd };

  useEffect(() => {
    let cancelled = false;
    const s = ensureSession(leafId, initialCwd);
    const callbacks: Callbacks = {
      onSearchReady: (a) => cbRef.current.onSearchReady?.(a),
      onExit: (c) => cbRef.current.onExit?.(c),
      onCwd: (c) => cbRef.current.onCwd?.(c),
    };

    // Spawn the shell immediately. The renderer slot still binds after fonts
    // load below, but the PTY itself must never wait on `document.fonts.ready`:
    // a heavy first paint (AI window visible, many chat sessions) can starve
    // font resolution and leave the first terminal permanently blank. Output
    // is buffered in the dormant ring until the slot binds.
    s.callbacks = callbacks;
    startPtyIfNeeded(leafId, s);

    // Bind the renderer once the font pipeline settles. This must retry: on
    // project reopen (`resetWorkspace`) the whole tab subtree is remounted, so
    // `container.current` can legitimately be null at this exact moment. A
    // single bail used to leave the session with no slot forever — the shell
    // ran and streamed output into the dormant ring, but nothing was ever
    // rendered.
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const bind = (attempt: number) => {
      if (cancelled || s.disposed) return;
      const node = container.current;
      if (!node) {
        if (attempt < ATTACH_RETRY_BOUND) {
          retryTimer = setTimeout(() => bind(attempt + 1), ATTACH_RETRY_MS);
        } else {
          console.warn(
            `[Kai] terminal ${leafId}: container never mounted, renderer not bound`,
          );
        }
        return;
      }
      attachSession(leafId, node, callbacks);
      if (s.visibleNow && s.focusedNow) focusSlot(leafId);
    };
    s.ready.then(() => bind(0));
    return () => {
      cancelled = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      detachSession(leafId);
    };
  }, [leafId, container, initialCwd]);

  const fontSize = usePreferencesStore((p) => p.terminalFontSize);
  const zoomLevel = usePreferencesStore((p) => p.zoomLevel);
  useEffect(() => {
    applyFontSize(Math.max(4, Math.round(fontSize * zoomLevel)));
  }, [fontSize, zoomLevel]);

  const scrollback = usePreferencesStore((p) => p.terminalScrollback);
  useEffect(() => {
    applyScrollback(scrollback);
  }, [scrollback]);

  const webglPref = usePreferencesStore((p) => p.terminalWebglEnabled);
  useEffect(() => {
    applyWebglPreference(webglPref);
  }, [webglPref]);

  useEffect(() => {
    const s = sessions.get(leafId);
    if (!s) return;
    s.visibleNow = visible;
    s.focusedNow = focused;
    if (visible) {
      if (s.container && !s.hasSlot) bindLeafToSlot(leafId, s);
      setSlotFocused(leafId, focused);
      if (focused) focusSlot(leafId);
    } else if (s.hasSlot) {
      unbindLeafFromSlot(leafId, s);
    }
  }, [leafId, visible, focused]);

  const write = useCallback(
    (data: string) => sessions.get(leafId)?.pty?.write(data),
    [leafId],
  );

  const focus = useCallback(() => focusSlot(leafId), [leafId]);

  const getBuffer = useCallback(
    (maxLines = 200): string | null => {
      const s = sessions.get(leafId);
      if (!s) return null;
      const slot = getSlotForLeaf(leafId);
      if (slot) {
        const buf = slot.term.buffer.active;
        const total = buf.length;
        const lines: string[] = [];
        const start = Math.max(0, total - maxLines);
        for (let i = start; i < total; i++) {
          lines.push(buf.getLine(i)?.translateToString(true) ?? "");
        }
        while (lines.length && lines[lines.length - 1] === "") lines.pop();
        return lines.join("\n");
      }
      if (!s.snapshot) return "";
      const plain = stripAnsi(s.snapshot);
      const lines = plain.split(/\r?\n/);
      const tail = lines.slice(-maxLines);
      while (tail.length && tail[tail.length - 1] === "") tail.pop();
      return tail.join("\n");
    },
    [leafId],
  );

  const getSelection = useCallback((): string | null => {
    const slot = getSlotForLeaf(leafId);
    const sel = slot?.term.getSelection() ?? "";
    return sel.length > 0 ? sel : null;
  }, [leafId]);

  const applyTheme = useCallback(() => {
    applyPoolTheme();
  }, []);

  return useMemo(
    () => ({ write, focus, getBuffer, getSelection, applyTheme }),
    [write, focus, getBuffer, getSelection, applyTheme],
  );
}

const ANSI_RE =
  /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB012]|\x1b[78=>]|\x1bc|\x1b[NOP\]X^_]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}
