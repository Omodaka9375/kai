import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Source-contract: the panel-blink fix.
 *
 * Symptom: on refresh the whole source-control panel blinked — blanked to
 * "Loading repository" and back, wiping in-flight local state (the commit
 * message box). Root cause chain:
 *
 *  1. App derives the context path from the ACTIVE TAB / terminal leaf cwd,
 *     which flickers during tab switches (A → B → A within a few frames).
 *  2. useSourceControl.doRefresh BLANKS repo/status/hasRepo synchronously
 *     whenever the new context is not inside the current repo root.
 *  3. The panel state machine unmounts the whole ready body on blank.
 *
 * The fix: the context path must SETTLE (stay stable for CONTEXT_SETTLE_MS)
 * before it becomes the refresh context, and transient git failures keep
 * the last good snapshot instead of blanking.
 */

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("useSourceControl context settle (panel blink)", () => {
  const src = read("./useSourceControl.ts");

  it("debounces the context path before it can drive a refresh", () => {
    expect(src).toContain("const CONTEXT_SETTLE_MS = 200");
    expect(src).toMatch(
      /const \[settledContextPath, setSettledContextPath\] = useState\(contextPath\)/,
    );
    // Flickers never reach git: the snapshot calls take the settled path.
    expect(src).not.toMatch(
      /await native\.gitPanelSnapshot\(contextPath\)/,
    );
  });

  it("transient git failures keep the last good snapshot", () => {
    // The catch branch must NOT unconditionally null repo/status — only
    // when there is no data at all (first load into a fresh context).
    const catchIdx = src.indexOf("} catch (error) {");
    const keepIdx = src.indexOf("if (current.status || current.repo) {");
    expect(catchIdx).toBeGreaterThan(-1);
    expect(keepIdx).toBeGreaterThan(catchIdx);
    // The keep branch preserves repo/status; the no-data branch nulls.
    const noDataIdx = src.indexOf("repo: null,", keepIdx);
    expect(noDataIdx).toBeGreaterThan(keepIdx);
  });

  it("reusable-root comparison uses the settled path", () => {
    expect(src).toMatch(
      /settledContextPath === activeRoot \|\|\n\s*settledContextPath\.startsWith/,
    );
  });
});

describe("useSourceControl identity-preserving refresh (focus blink)", () => {
  // REGRESSION: every window focus fires a debounced refresh. The refreshed
  // snapshot is content-identical in the common case, but the old code
  // replaced repo/status objects unconditionally — identity churn cascaded
  // summary → panel reconcile effect → entry/row memos → the virtualized
  // list and repainted the whole panel on every focus ("focus blink").
  const src = read("./useSourceControl.ts");

  it("has content-equality helpers for status/repo/changed-file", () => {
    expect(src).toContain("function statusEqual(");
    expect(src).toContain("function repoEqual(");
    expect(src).toContain("function changedFileEquals(");
  });

  it("a settled, in-place refresh does not touch state identity", () => {
    // The "refreshing in place" guard: same repo + data on screen + idle
    // ⇒ return the SAME state object (no isLoading/isSyncing flip).
    expect(src).toContain("reusableRoot &&");
    expect(src).toMatch(/return current;\n\s*}\n\s*return \{ \.\.\.current, isLoading: true/);
  });

  it("landing identical snapshot data keeps previous object identities", () => {
    expect(src).toMatch(/repo: sameRepo \? current\.repo : nextRepo/);
    expect(src).toMatch(/status: sameStatus \? current\.status : status/);
  });

  it("a fetch that changes nothing keeps the previous status identity", () => {
    // The post-fetch setState keeps current.status on equal content.
    expect(src).toMatch(
      /statusEqual\(current\.status, fresh\)\n?\s*\? current\.status\n?\s*: fresh/,
    );
  });
});

describe("useSourceControl refresh triggers (no background blinking)", () => {
  // User request: the panel "blinked a lot trying to refresh and check
  // state". Refreshes must fire ONLY on explicit user action (panel click,
  // rail icon, refresh icon) plus a boot-once load and a repo-null
  // re-resolve on context switch. The old triggers are REMOVED:
  const src = read("./useSourceControl.ts");
  const app = read("../../app/App.tsx");

  it("no window-focus refresh listener", () => {
    expect(src).not.toContain('window.addEventListener("focus"');
  });

  it("no per-context-change auto refresh (boot-once only, repo-null re-resolve)", () => {
    // The boot effect is keyed on `enabled` ALONE - no contextPath /
    // workspaceKey churn re-fires it on every tab switch or cd.
    expect(src).toMatch(
      /BOOT-ONCE: no contextPath\/workspaceKey in the deps/,
    );
    // The context-change re-resolve is repo-null gated (one-shot per
    // context switch, local-only).
    expect(src).toMatch(/if \(stateRef\.current\.repo\) return;/);
    expect(src).toMatch(/void refresh\(\{ remote: "never" \}\);\n\s*\/\/ eslint-disable/);
  });

  it("no save/terminal-command file-change listeners in App", () => {
    // The old Kai:sc-file-change / Kai:term-command-end schedule hooks are
    // gone; the events themselves remain (other consumers).
    const sc = app.slice(app.indexOf("Explicit refresh triggers"));
    expect(sc).not.toContain('window.addEventListener("Kai:sc-file-change"');
    expect(sc).not.toContain('window.addEventListener("Kai:term-command-end"');
  });

  it("explicit triggers exist: panel click-in, rail icon, refresh icon", () => {
    // Panel component: pointerdown inside the panel requests a refresh.
    const panel = read("./SourceControlPanel.tsx");
    expect(panel).toContain("data-source-control-panel");
    expect(panel).toContain("onRequestRefresh?.()");
    // App: rail icon click refreshes (even when the panel is already open).
    expect(app).toContain("handleSourceControlIconClick");
    expect(app).toMatch(/if \(view === "source-control"\) \{\n\s*void manualScRefreshRef\.current/);
    // The panel's own Refresh icon path (handleRefresh -> scm.refresh) is
    // unchanged and remains one of the three triggers.
    expect(panel).toContain("onClick={handleRefresh}");
  });
});