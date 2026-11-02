import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Windows commit-box bug (2026-11-02): "when I click on Commit message it
 * refreshes and my typing cursor is gone; it keeps refreshing."
 *
 * Root cause: Rust's canonical_dir returns Windows repo roots BACKSLASHED
 * (D:\Code\KAI) while the panel's context path arrives forward-slashed from
 * OSC 7 (D:/Code/KAI). The reusable-root check compared raw strings, never
 * matched on Windows, so every refresh blanked repo/status → panelState
 * flipped ready→loading→ready → the commit textarea UNMOUNTED (caret gone)
 * → the pointerdown listener re-fired on the next click. macOS/Linux match
 * separators, which is why the earlier blink fixes never saw it.
 *
 * reusableRepoRoot is exported pure; the exemption pin guards the click
 * handler.
 */

import { reusableRepoRoot } from "./useSourceControl";

describe("reusableRepoRoot — separator-blind identity", () => {
  it("matches a Windows backslashed root against a forward-slashed context", () => {
    // The exact failure shape: Rust root vs OSC 7 context.
    expect(reusableRepoRoot("D:\\Code\\2026\\KAI", "D:/Code/2026/KAI")).toBe(
      "D:\\Code\\2026\\KAI",
    );
  });

  it("matches identical separators too (macOS/Linux shape)", () => {
    expect(reusableRepoRoot("/home/user/repo", "/home/user/repo")).toBe(
      "/home/user/repo",
    );
    expect(reusableRepoRoot("/home/user/repo", "/home/user/repo/sub")).toBe(
      "/home/user/repo",
    );
  });

  it("a subdirectory of the root reuses the root", () => {
    expect(
      reusableRepoRoot("D:\\Code\\KAI", "D:/Code/KAI/src/modules"),
    ).toBe("D:\\Code\\KAI");
  });

  it("case differences do not break identity (same rules as session keys)", () => {
    expect(reusableRepoRoot("D:\\Code\\Kai", "d:/code/kai")).toBe(
      "D:\\Code\\Kai",
    );
  });

  it("a DIFFERENT repo does not reuse", () => {
    expect(reusableRepoRoot("D:\\Code\\KAI", "D:/Code/other")).toBeNull();
    // Sibling with a shared prefix must not prefix-match into reuse.
    expect(reusableRepoRoot("D:\\Code\\KAI2", "D:/Code/KAI2x")).toBeNull();
  });

  it("null/empty inputs never reuse", () => {
    expect(reusableRepoRoot(null, "D:/x")).toBeNull();
    expect(reusableRepoRoot("D:\\x", null)).toBeNull();
    expect(reusableRepoRoot("", "")).toBeNull();
  });

  it("returns the ORIGINAL root (for the IPC call), not the normalized one", () => {
    const out = reusableRepoRoot("D:\\Code\\KAI", "D:/Code/KAI");
    expect(out).toContain("\\");
  });
});

describe("click-to-refresh exemption (source pins)", () => {
  const panel = readFileSync(
    new URL("./SourceControlPanel.tsx", import.meta.url),
    "utf8",
  );
  const hook = readFileSync(
    new URL("./useSourceControl.ts", import.meta.url),
    "utf8",
  );

  it("the commit textarea opts out of the pointerdown refresh trigger", () => {
    expect(panel).toMatch(/data-no-sc-refresh/);
    expect(panel).toMatch(
      /if \(target\.closest\("\[data-no-sc-refresh\]"\)\) return;/,
    );
  });

  it("the reusable-root comparison is separator-normalized, not raw", () => {
    expect(hook).toMatch(/reusableRepoRoot\(activeRoot, settledContextPath\)/);
    // The old raw comparison must not return.
    expect(hook).not.toMatch(
      /settledContextPath === activeRoot \|\|\s*\n\s*settledContextPath\.startsWith/,
    );
    expect(hook).toMatch(/normalizeWorkspacePath/);
  });
});
