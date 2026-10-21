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