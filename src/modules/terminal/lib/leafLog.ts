import { invoke } from "@tauri-apps/api/core";

/**
 * Shared leaf-keyed diagnostics for the terminal renderer.
 *
 * logLeaf appends to %APPDATA%/app.kai.terminal/term-debug.log via the app's
 * own fs_read_file/fs_write_file commands (the fs plugin isn't wired). The
 * serialized-append promise chain (logChain) MUST stay in one module: both
 * useTerminalSession and rendererPool log lines for the same leaf within
 * milliseconds of each other, and two independent read-modify-write chains
 * would clobber each other's lines — the exact bug that made the earliest
 * prod logs lie by omission. Lives here so rendererPool can log the unhide
 * reveal (the blank-pane smoking gun) through the same chain.
 */

/** Leaf-keyed lifecycle logging — `pty opened id=N` lines are unkeyed on the
 *  Rust side, so this is the only way to tell which tab a spawn belongs to.
 *  ALSO appends to %APPDATA%/app.kai.terminal/term-debug.log (fire-and-forget,
 *  ring-truncated) so a live repro in the packaged app can be read back
 *  without devtools — the blank-first-terminal family has burned us three
 *  times and console-only logs were never captured. Uses the app's own
 *  fs_read_file/fs_write_file commands (the fs plugin isn't wired). */
export function logLeaf(leafId: number, msg: string): void {
  const line = `[${new Date().toISOString()} leaf=${leafId}] ${msg}`;
  console.info(`[Kai-term leaf=${leafId}] ${msg}`);
  // SERIALIZED appends. The first cut fired each line as an independent
  // async read-modify-write — two logLeaf calls milliseconds apart (e.g.
  // "binding renderer slot" then "slot #N bound", or the spawn/bind burst)
  // both read the same previous content and the second write silently
  // clobbered the first. That's why prod logs showed "renderer slot #N
  // bound" with no preceding "binding renderer slot" anywhere — the
  // instrumentation itself was lying by omission. A module-level promise
  // chain makes each append wait for the previous one; reads still happen
  // per-write so lines from another KAI process interleave instead of
  // overwriting.
  logChain = logChain.then(async () => {
    try {
      const dir = await import("@tauri-apps/api/path").then((p) => p.appDataDir());
      const file = `${dir.replace(/\\/g, "/")}/term-debug.log`;
      const prev = await invoke<{ kind: string; content?: string }>("fs_read_file", {
        path: file,
        extract: false,
      })
        .then((r) => (r?.kind === "text" && typeof r.content === "string" ? r.content : ""))
        .catch(() => "");
      const kept = prev.length > 400_000 ? prev.slice(-200_000) : prev;
      await invoke("fs_write_file", { path: file, content: kept + line + "\n" });
    } catch {
      /* diagnostics must never break the terminal */
    }
  });
}
let logChain: Promise<void> = Promise.resolve();

/**
 * Compact "what is actually painted here" probe for the blank-pane case
 * where the whole spawn→bind→output pipeline logged healthy: the pane is
 * alive in the DOM and xterm's buffer has content, yet nothing shows.
 * Only two layers can hide it: CSS (an `invisible`/opacity/display class
 * on the pane or an ancestor — tab-hiding literally uses
 * `invisible pointer-events-none`, and a React class/state desync would
 * hide a healthy pane) or the renderer engine itself (webgl context lost
 * in WebView2 paints nothing while the buffer streams).
 *
 * Reports: container rect; computed visibility/display/opacity of the
 * container and the FIRST ancestor where any is non-normal (the culprit
 * chain); xterm's data-engine (canvas|webgl|dom); the canvas size; and
 * what document.elementFromPoint says is topmost at the pane's center —
 * that is literally what the user sees at that pixel.
 */
export function describeRenderEnv(container: HTMLElement | null): string {
  if (!container) return "env(no container)";
  try {
    const r = container.getBoundingClientRect();
    const styleOf = (el: Element) => {
      const cs = getComputedStyle(el);
      return `${cs.display}/${cs.visibility}/op${cs.opacity}`;
    };
    // Climb for the first ancestor that is itself hiding content.
    let culprit = "";
    let el: Element | null = container;
    for (let d = 0; el && d < 8; d += 1) {
      const cs = getComputedStyle(el);
      const hidden =
        cs.visibility !== "visible" ||
        cs.display === "none" ||
        parseFloat(cs.opacity) === 0;
      if (hidden) {
        culprit = `depth${d}:${el.tagName.toLowerCase()}.${(typeof el.className === "string" ? el.className : "").trim().split(/\s+/).slice(0, 3).join(".")}(${styleOf(el)})`;
        break;
      }
      el = el.parentElement;
    }
    const screen = container.querySelector(".xterm-screen");
    const engine = screen?.getAttribute("data-engine") ?? "?";
    const canvases = Array.from(container.querySelectorAll("canvas"))
      .map((c) => `${c.width}x${c.height}`)
      .join(",") || "none";
    let hit = "oob";
    if (r.width > 0 && r.height > 0) {
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      hit = top
        ? `${container.contains(top) ? "IN" : "COVERED-BY"}:${top.tagName.toLowerCase()}.${(typeof top.className === "string" ? top.className : "").trim().split(/\s+/).slice(0, 2).join(".")}`
        : "null";
    }
    return `env ${Math.round(r.width)}x${Math.round(r.height)} engine=${engine} canvas=${canvases} topAt=${hit} hiddenAncestor=${culprit || "none"}`;
  } catch (e) {
    return `env probe threw: ${String(e)}`;
  }
}
