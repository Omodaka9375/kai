import { detectMonoFontFamily } from "@/lib/fonts";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { buildTerminalTheme } from "@/styles/terminalTheme";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";

/** Open a URL, routing localhost / proxy-eligible links to the preview tab. */
function smartOpenUrl(uri: string): void {
  let isLocal = false;
  try {
    const u = new URL(uri);
    isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  } catch { /* invalid URL — fall through to OS browser */ }
  const hasProxy = !!usePreferencesStore.getState().previewProxyUrl;

  if (isLocal || hasProxy) {
    // Dispatch a custom event that App.tsx listens for.
    window.dispatchEvent(new CustomEvent<string>("Kai:open-in-preview", { detail: uri }));
  } else {
    void openUrl(uri).catch(console.error);
  }
}

export const POOL_MAX_SIZE = 5;
const FIT_DEBOUNCE_MS = 8;
const PTY_RESIZE_DEBOUNCE_MS = 256;
const SNAPSHOT_SCROLLBACK_CAP = 5_000;

export type SlotAdapter = {
  resolveLeaf(leafId: number): LeafBridge | null;
  evictLeaf(leafId: number): void;
  isLeafFocused(leafId: number): boolean;
};

export type LeafBridge = {
  writeToPty(data: string): void;
  resizePty(cols: number, rows: number): void;
};

export type Slot = {
  readonly id: number;
  readonly term: Terminal;
  readonly fitAddon: FitAddon;
  readonly searchAddon: SearchAddon;
  readonly serializeAddon: SerializeAddon;
  readonly host: HTMLDivElement;
  webglAddon: WebglAddon | null;
  webglCanvases: HTMLCanvasElement[];
  currentLeafId: number | null;
  oscDisposers: (() => void)[];
  observer: ResizeObserver | null;
  fitTimer: ReturnType<typeof setTimeout> | null;
  ptyTimer: ReturnType<typeof setTimeout> | null;
  unhideRaf: number | null;
  unhideTimer: ReturnType<typeof setTimeout> | null;
  webglRecoveryTimer: ReturnType<typeof setTimeout> | null;
  lastCols: number;
  lastRows: number;
  lastW: number;
  lastH: number;
  lastUsedAt: number;
};

const slots: Slot[] = [];
let recyclerEl: HTMLDivElement | null = null;
let adapter: SlotAdapter | null = null;

export function configureRendererPool(a: SlotAdapter): void {
  adapter = a;
  startFocusedPaneDomWatch();
}

/**
 * Periodic DOM-truth watchdog for the FOCUSED pane. The at-unhide audit
 * only covers bind time (+1.5s); an intermittent blank that strikes later
 * (tab switches, sleep/wake, late activeId flips) left no trace. Every 5s
 * the focused slot is audited; a problem WARNs once per 30s per issue
 * (deduped), healthy runs log nothing. This is the instrument that names
 * the layer whenever the intermittent blank pane strikes, whenever it
 * strikes.
 */
const DOM_WATCH_INTERVAL_MS = 5000;
const DOM_WATCH_DEDUP_MS = 30000;
let domWatchTimer: ReturnType<typeof setInterval> | null = null;
const domWatchLastWarn = new Map<string, number>();

function startFocusedPaneDomWatch(): void {
  if (domWatchTimer !== null) return; // idempotent — single pool lifetime
  domWatchTimer = setInterval(() => {
    for (const slot of slots) {
      const leafId = slot.currentLeafId;
      if (leafId === null) continue;
      if (!adapter?.isLeafFocused(leafId)) continue;
      try {
        const problem = domTruthOfSlot(slot.host, slot.webglAddon !== null);
        if (!problem) continue;
        const key = `${slot.id}:${problem.slice(0, 80)}`;
        const now = Date.now();
        const last = domWatchLastWarn.get(key) ?? 0;
        if (now - last < DOM_WATCH_DEDUP_MS) continue;
        domWatchLastWarn.set(key, now);
        console.warn(
          `[Kai-term leaf=${leafId}] FOCUSED pane not visible (watchdog) — ${problem}`,
        );
      } catch {
        // diagnostics must never throw from an interval
      }
    }
  }, DOM_WATCH_INTERVAL_MS);
}

export function forEachSlot(fn: (slot: Slot) => void): void {
  for (const s of slots) fn(s);
}

export function poolSize(): number {
  return slots.length;
}

function getRecycler(): HTMLDivElement {
  if (recyclerEl && recyclerEl.isConnected) return recyclerEl;
  const el = document.createElement("div");
  el.setAttribute("data-Kai-recycler", "");
  el.style.cssText =
    "position:fixed;left:-99999px;top:-99999px;width:1024px;height:768px;overflow:hidden;pointer-events:none;contain:strict;";
  document.body.appendChild(el);
  recyclerEl = el;
  return el;
}

function termOptions() {
  const prefs = usePreferencesStore.getState();
  return {
    fontFamily: detectMonoFontFamily(),
    fontSize: Math.max(4, Math.round(prefs.terminalFontSize * prefs.zoomLevel)),
    theme: buildTerminalTheme(),
    cursorBlink: false,
    cursorStyle: "bar" as const,
    cursorInactiveStyle: "outline" as const,
    scrollback: prefs.terminalScrollback,
    allowProposedApi: true,
  };
}

function createSlot(): Slot {
  const term = new Terminal(termOptions());
  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  const serializeAddon = new SerializeAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(searchAddon);
  term.loadAddon(serializeAddon);
  term.loadAddon(
    new WebLinksAddon((_e, uri) => smartOpenUrl(uri)),
  );

  const host = document.createElement("div");
  host.style.cssText = "width:100%;height:100%;";
  host.setAttribute("data-Kai-slot", String(slots.length));
  getRecycler().appendChild(host);
  term.open(host);

  const slot: Slot = {
    id: slots.length,
    term,
    fitAddon,
    searchAddon,
    serializeAddon,
    host,
    webglAddon: null,
    webglCanvases: [],
    currentLeafId: null,
    oscDisposers: [],
    observer: null,
    fitTimer: null,
    ptyTimer: null,
    unhideRaf: null,
    unhideTimer: null,
    webglRecoveryTimer: null,
    lastCols: term.cols,
    lastRows: term.rows,
    lastW: 0,
    lastH: 0,
    lastUsedAt: 0,
  };

  attachWebgl(slot);

  term.attachCustomKeyEventHandler((event) => {
    const leafId = slot.currentLeafId;
    if (leafId === null) return false;
    const bridge = adapter?.resolveLeaf(leafId);
    if (!bridge) return true;
    if (isCtrlBackspace(event)) {
      event.preventDefault();
      if (event.type === "keydown") bridge.writeToPty("\x17");
      return false;
    }
    if (isShiftEnter(event)) {
      event.preventDefault();
      if (event.type === "keydown") bridge.writeToPty("\x1b\r");
      return false;
    }
    return true;
  });

  term.onData((data) => {
    const leafId = slot.currentLeafId;
    if (leafId === null) return;
    adapter?.resolveLeaf(leafId)?.writeToPty(data);
  });

  slots.push(slot);
  return slot;
}

type PickResult = { slot: Slot; previousLeafId: number | null };

function isAltScreen(s: Slot): boolean {
  try {
    return s.term.buffer.active.type === "alternate";
  } catch {
    return false;
  }
}

function pickSlotFor(leafId: number): PickResult {
  const free = slots.find((s) => s.currentLeafId === null);
  if (free) return { slot: free, previousLeafId: null };
  if (slots.length < POOL_MAX_SIZE)
    return { slot: createSlot(), previousLeafId: null };

  let best: Slot | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const s of slots) {
    if (s.currentLeafId === leafId) return { slot: s, previousLeafId: null };
    const focused =
      s.currentLeafId !== null &&
      (adapter?.isLeafFocused(s.currentLeafId) ?? false);
    const score =
      (isAltScreen(s) ? 100 : 0) + (focused ? 10 : 0) + s.lastUsedAt / 1e12;
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  const chosen = best!;
  // Notify the adapter so it can snapshot/unbind the evicted leaf,
  // then destroy the slot to release GPU/DOM/event resources.
  if (chosen.currentLeafId !== null) {
    adapter?.evictLeaf(chosen.currentLeafId);
  }
  destroySlot(chosen);
  // Create a fresh terminal — recycling a disposed Terminal is not safe.
  return { slot: createSlot(), previousLeafId: null };
}

export type AcquireParams = {
  leafId: number;
  container: HTMLDivElement;
  snapshot: string | null;
  drainRing: (write: (bytes: Uint8Array) => void) => void;
  shellExited: boolean;
  searchQuery: string | null;
  cols: number;
  rows: number;
  onScopeChange: (cols: number, rows: number) => void;
  registerOsc: (term: Terminal) => (() => void)[];
  onSearchReady: (addon: SearchAddon) => void;
};

export function acquireSlot(params: AcquireParams): Slot {
  const existing = slots.find((s) => s.currentLeafId === params.leafId);
  if (existing) {
    rewireSlot(existing, params);
    return existing;
  }

  const pick = pickSlotFor(params.leafId);
  if (
    pick.slot.currentLeafId !== null &&
    pick.slot.currentLeafId !== params.leafId
  ) {
    detachSlotFromLeaf(pick.slot);
  }
  bindSlot(pick.slot, params);
  return pick.slot;
}

function bindSlot(slot: Slot, p: AcquireParams): void {
  slot.currentLeafId = p.leafId;
  slot.lastUsedAt = performance.now();

  cancelPendingUnhide(slot);
  slot.host.style.visibility = "hidden";

  try {
    if (slot.host.parentNode !== p.container) {
      p.container.appendChild(slot.host);
    }

    slot.term.options.disableStdin = p.shellExited;
    slot.term.clear();
    slot.term.reset();

    if (
      p.cols > 0 &&
      p.rows > 0 &&
      (slot.term.cols !== p.cols || slot.term.rows !== p.rows)
    ) {
      slot.term.resize(p.cols, p.rows);
    }

    if (p.snapshot) {
      try {
        slot.term.write(p.snapshot);
      } catch (e) {
        console.warn("[Kai] snapshot replay failed:", e);
      }
    }
    p.drainRing((bytes) => slot.term.write(bytes));
    try {
      slot.term.write("\x1b[?25h");
    } catch (e) {
      console.debug("[Kai-pool] cursor-show write failed:", e);
    }

    for (const d of slot.oscDisposers) {
      try {
        d();
      } catch (e) {
        console.debug("[Kai-pool] osc disposer failed:", e);
      }
    }
    slot.oscDisposers = p.registerOsc(slot.term);

    setupResizeObserver(slot, p);
    slot.fitAddon.fit();
    slot.lastCols = slot.term.cols;
    slot.lastRows = slot.term.rows;
    slot.lastW = p.container.clientWidth;
    slot.lastH = p.container.clientHeight;
    if (slot.lastCols !== p.cols || slot.lastRows !== p.rows) {
      p.onScopeChange(slot.lastCols, slot.lastRows);
      // Keep ConPTY in sync with the fitted viewport immediately. The PTY is
      // spawned at a default size (80x24); if we only update the session cache
      // here and wait for a later ResizeObserver change, ConPTY keeps rendering
      // at the wrong dimensions — its repaints and `clear` then target the wrong
      // row range, which shows up as artifacts overwriting past lines and a
      // `clear` that doesn't clear the bottom of the pane.
      adapter?.resolveLeaf(p.leafId)?.resizePty(slot.lastCols, slot.lastRows);
    }

    if (p.searchQuery) {
      try {
        slot.searchAddon.findNext(p.searchQuery);
      } catch (e) {
        console.debug("[Kai-pool] search replay failed:", e);
      }
    }

    applyCursorBlinkOnSlot(slot, adapter?.isLeafFocused(p.leafId) ?? false);
  } catch (e) {
    // A throw anywhere between the visibility:hidden above and the unhide
    // below used to leave the host permanently hidden: a slot that still
    // streamed output and accepted typing, but rendered NOTHING (blank
    // pane, live shell — seen on project reopen). Worse, the throw escaped
    // as an unhandled promise rejection (the font-gate `.then(bind)` had no
    // catch), so it never appeared in any log. Roll the slot back to a
    // clean detached state and rethrow — the session bind-retry loop and
    // watchdog handle recovery.
    console.error("[Kai-pool] bindSlot failed — rolling back slot:", e);
    detachSlotFromLeaf(slot);
    throw e;
  }

  // Reached on every success path (the catch path restored visibility via
  // detachSlotFromLeaf) — the unhide can no longer be skipped.
  scheduleUnhide(slot);

  p.onSearchReady(slot.searchAddon);
}

// Unhiding must not depend on rAF alone: while the OS window is hidden
// (packaged boots start hidden until first paint) Chromium does not run the
// rAF loop, and pending callbacks can sit queued indefinitely on WebView2 —
// leaving the slot permanently `visibility:hidden`: a bound, streaming,
// yet blank terminal pane. A short timer guarantees the unhide.
const UNHIDE_FALLBACK_MS = 400;

/**
 * DOM-truth audit for a slot host. The pool's own state (bound, unhidden,
 * connected) can be entirely green while the pane is invisible — every
 * hide layer ABOVE the host (App's `invisible` wrapper for non-active tab
 * kinds, TerminalStack's inline `visibility:hidden` for non-active tab ids)
 * blanks the pane without any pool log noticing. This walks the ancestor
 * chain and reports the first thing that would make the host invisible.
 */
function domTruthOfSlot(host: HTMLElement, webglAttached: boolean): string | null {
  // Recycler check FIRST: the recycler is offscreen-positioned
  // (left:-99999px) — NOT display:none/visibility:hidden — so the
  // ancestor walk below passes clean through it and the host still
  // reports a fake 1024x768 size. A host stuck here = blank pane with
  // every other audit green.
  if (host.closest("[data-Kai-recycler]")) {
    return "host still in the offscreen recycler — bind never moved it into the pane";
  }
  const rect = host.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return `host rect ${Math.round(rect.width)}x${Math.round(rect.height)}px (zero size)`;
  }
  const offenders: string[] = [];
  let node: HTMLElement | null = host;
  let depth = 0;
  while (node && node !== document.documentElement && depth < 24) {
    const cs = window.getComputedStyle(node);
    const cls = typeof node.className === "string" && node.className ? `.${node.className.split(/\s+/).slice(0, 4).join(".")}` : "";
    const tag = `<${node.tagName.toLowerCase()}${cls}>`;
    if (cs.visibility === "hidden") offenders.push(`${tag} visibility:hidden`);
    else if (cs.display === "none") offenders.push(`${tag} display:none`);
    node = node.parentElement;
    depth++;
  }
  if (offenders.length > 0) return `hidden ancestors: ${offenders.join(" <- ")}`;
  // Canvas layer: a lost WebGL context (or a renderer that never painted)
  // leaves a black pane with every pool log green. Count + size of the
  // canvases xterm rendered is the only DOM-visible signal.
  const canvases = host.querySelectorAll("canvas");
  if (canvases.length === 0) {
    return `no canvas in host (renderer never painted; webgl=${webglAttached ? "on" : "off"})`;
  }
  const deadCanvas = Array.from(canvases).find(
    (c) => c.width === 0 || c.height === 0,
  );
  if (deadCanvas) {
    return `zero-size canvas ${deadCanvas.width}x${deadCanvas.height} (webgl=${webglAttached ? "on" : "off"})`;
  }
  // Topmost-element check: what is ACTUALLY at the pane's center on
  // screen? Catches opaque overlays ABOVE the pane (siblings — invisible
  // to the ancestor walk) and offscreen hosts. pointer-events:none
  // wrappers are transparent to elementFromPoint, so a hit outside the
  // host is a genuinely covering element.
  const cx = Math.min(
    Math.max(rect.left + rect.width / 2, 1),
    Math.max(window.innerWidth - 1, 1),
  );
  const cy = Math.min(
    Math.max(rect.top + rect.height / 2, 1),
    Math.max(window.innerHeight - 1, 1),
  );
  const topEl = document.elementFromPoint(cx, cy);
  if (!topEl) {
    return `elementFromPoint(${Math.round(cx)},${Math.round(cy)}) = null — host offscreen`;
  }
  if (!host.contains(topEl)) {
    const cls =
      typeof topEl.className === "string" && topEl.className
        ? `.${topEl.className.split(/\s+/).slice(0, 4).join(".")}`
        : "";
    return `covered by <${topEl.tagName.toLowerCase()}${cls}> at pane center — opaque overlay above the host`;
  }
  return null;
}

function scheduleUnhide(slot: Slot): void {
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    slot.unhideRaf = null;
    slot.unhideTimer = null;
    slot.host.style.visibility = "";
    console.info(
      `[Kai-term leaf=${slot.currentLeafId ?? "?"}] slot unhidden ` +
        `${slot.host.offsetWidth}x${slot.host.offsetHeight}px ` +
        `connected=${slot.host.isConnected}`,
    );
    // DOM-truth audit: catches a slot whose host is unhidden but an
    // ancestor (tab wrapper) hides the whole pane — the "blank terminal,
    // every pool log green" class. Runs once at unhide and once after the
    // tab-switch dust settles (late `invisible` flips from activeId races).
    const leafAtBind = slot.currentLeafId;
    const audit = (phase: string) => {
      try {
        const problem = domTruthOfSlot(slot.host, slot.webglAddon !== null);
        if (problem) {
          console.warn(
            `[Kai-term leaf=${slot.currentLeafId ?? "?"}] ` +
              `slot unhidden but NOT VISIBLE (${phase}) — ${problem}`,
          );
        } else {
          console.info(
            `[Kai-term leaf=${slot.currentLeafId ?? "?"}] dom audit clean (${phase})`,
          );
        }
      } catch {
        // diagnostics must never break the unhide path
      }
    };
    audit("at-unhide");
    setTimeout(() => {
      if (slot.currentLeafId === leafAtBind) audit("post-settle");
    }, 1500);
    const leafId = slot.currentLeafId;
    if (leafId !== null && adapter?.isLeafFocused(leafId)) {
      slot.term.focus();
    }
  };
  slot.unhideRaf = requestAnimationFrame(() => {
    slot.unhideRaf = requestAnimationFrame(() => finish());
  });
  slot.unhideTimer = setTimeout(finish, UNHIDE_FALLBACK_MS);
}

function cancelPendingUnhide(slot: Slot): void {
  if (slot.unhideRaf !== null) {
    cancelAnimationFrame(slot.unhideRaf);
    slot.unhideRaf = null;
  }
  if (slot.unhideTimer !== null) {
    clearTimeout(slot.unhideTimer);
    slot.unhideTimer = null;
  }
}

function rewireSlot(slot: Slot, p: AcquireParams): void {
  slot.lastUsedAt = performance.now();
  if (slot.host.parentNode !== p.container) {
    p.container.appendChild(slot.host);
  }
  setupResizeObserver(slot, p);
  slot.fitAddon.fit();
  slot.lastW = p.container.clientWidth;
  slot.lastH = p.container.clientHeight;
  if (slot.term.cols !== p.cols || slot.term.rows !== p.rows) {
    p.onScopeChange(slot.term.cols, slot.term.rows);
    adapter?.resolveLeaf(p.leafId)?.resizePty(slot.term.cols, slot.term.rows);
  }
  p.onSearchReady(slot.searchAddon);
}

function setupResizeObserver(slot: Slot, p: AcquireParams): void {
  slot.observer?.disconnect();
  if (slot.fitTimer) clearTimeout(slot.fitTimer);
  if (slot.ptyTimer) clearTimeout(slot.ptyTimer);
  slot.fitTimer = null;
  slot.ptyTimer = null;

  const container = p.container;
  const flushPty = () => {
    slot.ptyTimer = null;
    if (slot.currentLeafId !== p.leafId) return;
    if (slot.term.cols === slot.lastCols && slot.term.rows === slot.lastRows)
      return;
    slot.lastCols = slot.term.cols;
    slot.lastRows = slot.term.rows;
    const bridge = adapter?.resolveLeaf(p.leafId);
    bridge?.resizePty(slot.term.cols, slot.term.rows);
    p.onScopeChange(slot.lastCols, slot.lastRows);
  };

  slot.observer = new ResizeObserver(() => {
    if (slot.fitTimer) clearTimeout(slot.fitTimer);
    slot.fitTimer = setTimeout(() => {
      slot.fitTimer = null;
      if (slot.currentLeafId !== p.leafId) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === slot.lastW && h === slot.lastH) return;
      slot.lastW = w;
      slot.lastH = h;
      slot.fitAddon.fit();
      if (slot.ptyTimer) clearTimeout(slot.ptyTimer);
      slot.ptyTimer = setTimeout(flushPty, PTY_RESIZE_DEBOUNCE_MS);
    }, FIT_DEBOUNCE_MS);
  });
  slot.observer.observe(container);
}

export type SerializeOutput = {
  snapshot: string | null;
  cols: number;
  rows: number;
};

export function releaseSlot(leafId: number): SerializeOutput | null {
  const slot = slots.find((s) => s.currentLeafId === leafId);
  if (!slot) return null;
  const out = serializeSlot(slot);
  detachSlotFromLeaf(slot);
  return out;
}

function serializeSlot(slot: Slot): SerializeOutput {
  let snapshot: string | null = null;
  try {
    const cap = Math.min(
      SNAPSHOT_SCROLLBACK_CAP,
      usePreferencesStore.getState().terminalScrollback,
    );
    snapshot = slot.serializeAddon.serialize({ scrollback: cap });
  } catch (e) {
    console.warn("[Kai] serialize failed:", e);
  }
  return { snapshot, cols: slot.term.cols, rows: slot.term.rows };
}

function detachSlotFromLeaf(slot: Slot): void {
  for (const d of slot.oscDisposers) {
    try {
      d();
    } catch (e) { console.debug("[Kai-pool] osc disposer failed:", e); }
  }
  slot.oscDisposers = [];

  slot.observer?.disconnect();
  slot.observer = null;
  if (slot.fitTimer) clearTimeout(slot.fitTimer);
  if (slot.ptyTimer) clearTimeout(slot.ptyTimer);
  slot.fitTimer = null;
  slot.ptyTimer = null;

  cancelPendingUnhide(slot);
  slot.host.style.visibility = "";

  if (slot.host.parentNode !== getRecycler()) {
    getRecycler().appendChild(slot.host);
  }

  if (slot.webglRecoveryTimer) {
    clearTimeout(slot.webglRecoveryTimer);
    slot.webglRecoveryTimer = null;
  }

  slot.currentLeafId = null;
  slot.lastUsedAt = performance.now();
}

/** Fully destroy a slot, releasing all GPU, DOM, and event-listener resources. */
function destroySlot(slot: Slot): void {
  detachSlotFromLeaf(slot);
  disposeSlotWebgl(slot);
  try {
    slot.term.dispose();
  } catch (e) {
    console.warn("[Kai-pool] terminal dispose failed:", e);
  }
  // Remove host from wherever it's attached, then drop it.
  if (slot.host.parentNode) {
    slot.host.parentNode.removeChild(slot.host);
  }
  const idx = slots.indexOf(slot);
  if (idx !== -1) slots.splice(idx, 1);
}

const WEBGL_RECOVERY_DELAY_MS = 250;

function attachWebgl(slot: Slot): void {
  if (slot.webglAddon || !slot.term.element) return;
  if (!usePreferencesStore.getState().terminalWebglEnabled) return;
  const elem = slot.term.element;
  const before = new Set<HTMLCanvasElement>(
    elem.querySelectorAll<HTMLCanvasElement>("canvas"),
  );
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      const cur = slot.webglAddon;
      if (cur === webgl) {
        slot.webglAddon = null;
        slot.webglCanvases = [];
      }
      try {
        webgl.dispose();
      } catch (e) { console.debug("[Kai-webgl] context-loss dispose failed:", e); }
      // Recovery: WebKit may transiently lose contexts on sleep/wake or GPU
      // reset; without re-attach the slot would silently fall back to DOM
      // forever. Defer past WebKit's reset window before retrying.
      if (slot.webglRecoveryTimer) clearTimeout(slot.webglRecoveryTimer);
      slot.webglRecoveryTimer = setTimeout(() => {
        slot.webglRecoveryTimer = null;
        if (slot.webglAddon) return;
        if (!usePreferencesStore.getState().terminalWebglEnabled) return;
        attachWebgl(slot);
      }, WEBGL_RECOVERY_DELAY_MS);
    });
    slot.term.loadAddon(webgl);
    const after = elem.querySelectorAll<HTMLCanvasElement>("canvas");
    const added: HTMLCanvasElement[] = [];
    for (const c of after) if (!before.has(c)) added.push(c);
    slot.webglAddon = webgl;
    slot.webglCanvases = added;
  } catch (e) {
    console.warn("[Kai-webgl] unavailable:", e);
  }
}

function disposeSlotWebgl(slot: Slot): void {
  if (!slot.webglAddon) return;
  const addon = slot.webglAddon;
  for (const canvas of slot.webglCanvases) releaseCanvasContext(canvas);
  slot.webglCanvases = [];
  try {
    addon.dispose();
  } catch (e) {
    console.warn("[Kai-webgl] dispose failed:", e);
  }
  try {
    const r = (
      addon as unknown as { _renderer?: Record<string, unknown> | null }
    )._renderer;
    if (r) {
      r._canvas = null;
      r._gl = null;
      r._charAtlas = null;
      r._atlas = null;
    }
    (
      addon as unknown as { _renderer?: unknown; _renderService?: unknown }
    )._renderer = null;
    (
      addon as unknown as { _renderer?: unknown; _renderService?: unknown }
    )._renderService = null;
  } catch (e) { console.debug("[Kai-webgl] renderer cleanup failed:", e); }
  slot.webglAddon = null;
}

function releaseCanvasContext(canvas: HTMLCanvasElement): void {
  let gl: WebGL2RenderingContext | WebGLRenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
  } catch (e) { console.debug("[Kai-webgl] getContext(webgl2) failed:", e); }
  if (!gl) {
    try {
      gl = canvas.getContext("webgl") as WebGLRenderingContext | null;
    } catch (e) { console.debug("[Kai-webgl] getContext(webgl) failed:", e); }
  }
  if (gl) {
    try {
      const ext = gl.getExtension("WEBGL_lose_context");
      if (ext && !gl.isContextLost()) ext.loseContext();
    } catch (e) { console.debug("[Kai-webgl] loseContext failed:", e); }
  }
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch (e) { console.debug("[Kai-webgl] canvas reset failed:", e); }
}

export function applyWebglPreference(enabled: boolean): void {
  for (const slot of slots) {
    if (enabled && !slot.webglAddon) attachWebgl(slot);
    else if (!enabled && slot.webglAddon) disposeSlotWebgl(slot);
  }
}

export function applyFontSize(size: number): void {
  for (const slot of slots) {
    if (slot.term.options.fontSize === size) continue;
    slot.term.options.fontSize = size;
    slot.fitAddon.fit();
    if (slot.currentLeafId !== null) {
      slot.lastCols = slot.term.cols;
      slot.lastRows = slot.term.rows;
      const bridge = adapter?.resolveLeaf(slot.currentLeafId);
      bridge?.resizePty(slot.term.cols, slot.term.rows);
    }
  }
}

export function applyScrollback(value: number): void {
  for (const slot of slots) {
    if (slot.term.options.scrollback === value) continue;
    slot.term.options.scrollback = value;
  }
}

export function applyTheme(): void {
  const theme = buildTerminalTheme();
  for (const slot of slots) {
    slot.term.options.theme = theme;
  }
}

export function focusSlot(leafId: number): void {
  const slot = slots.find((s) => s.currentLeafId === leafId);
  slot?.term.focus();
}

export function setSlotFocused(leafId: number, focused: boolean): void {
  const slot = slots.find((s) => s.currentLeafId === leafId);
  if (!slot) return;
  applyCursorBlinkOnSlot(slot, focused);
}

function applyCursorBlinkOnSlot(slot: Slot, focused: boolean): void {
  const desired = focused;
  if (slot.term.options.cursorBlink === desired) return;
  slot.term.options.cursorBlink = desired;
}

export function getSlotForLeaf(leafId: number): Slot | null {
  return slots.find((s) => s.currentLeafId === leafId) ?? null;
}

function isCtrlBackspace(e: KeyboardEvent): boolean {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const isMac = /Mac|iPhone|iPad/.test(ua);
  const mod = isMac ? e.metaKey : e.ctrlKey;
  return mod && (e.key === "Backspace" || e.code === "Backspace");
}

function isShiftEnter(e: KeyboardEvent): boolean {
  return (
    e.key === "Enter" && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
  );
}
