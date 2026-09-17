import { describe, expect, it, beforeEach } from "vitest";
import {
  discardShadow,
  getShadow,
  loadShadow,
  toShadow,
  fromShadow,
  _internal,
} from "./shadow";

const REAL = "D:/Code/Proj";

beforeEach(async () => {
  // Clear resident shadows between tests via discard semantics: the module
  // keys by real root, so discarding each known root suffices.
  for (const root of [REAL]) {
    if (getShadow(root)) await discardShadow(root).catch(() => undefined);
  }
});

describe("toShadow / fromShadow translation", () => {
  it("passes through when no shadow is active", () => {
    expect(toShadow(`${REAL}/src/a.ts`)).toBe(`${REAL}/src/a.ts`);
    expect(toShadow("/etc/passwd")).toBe("/etc/passwd");
  });

  it("redirects project paths into the shadow", async () => {
    await createShadowForTest();
    const shadow = getShadow(REAL);
    expect(shadow).not.toBeNull();
    const shadowRoot = shadow!.shadowRoot;

    expect(toShadow(`${REAL}/src/a.ts`)).toBe(`${shadowRoot}/src/a.ts`);
    expect(toShadow(REAL)).toBe(shadowRoot);
    // Backslash variants of the same project path redirect too.
    expect(toShadow(`D:\\Code\\Proj\\src\\a.ts`)).toBe(`${shadowRoot}/src/a.ts`);
    // Case-insensitive drive/project match.
    expect(toShadow(`d:/code/proj/x.txt`)).toBe(`${shadowRoot}/x.txt`);

    // NOT redirected: outside the project, home, other drives.
    expect(toShadow("/etc/passwd")).toBe("/etc/passwd");
    expect(toShadow("C:/Users/me/.ssh/config")).toBe("C:/Users/me/.ssh/config");
    expect(toShadow("E:/Other/file.txt")).toBe("E:/Other/file.txt");
    // Prefix-safety: /ProjX is a different project, not inside.
    expect(toShadow(`${REAL}X/file.txt`)).toBe(`${REAL}X/file.txt`);
  });

  it("fromShadow maps shadow paths back to the real project", async () => {
    await createShadowForTest();
    const shadowRoot = getShadow(REAL)!.shadowRoot;
    expect(fromShadow(`${shadowRoot}/src/a.ts`)).toBe(`${REAL}/src/a.ts`);
    expect(fromShadow("/etc/passwd")).toBe("/etc/passwd");
  });
});

describe("merge report formatting", () => {
  it("summarizes copied, conflicts, and deletions", async () => {
    const { formatMergeReport } = await import("./shadow");
    const text = formatMergeReport({
      copied: ["a.txt", "b.txt"],
      conflicts: ["c.txt"],
      deletedInShadow: ["d.txt"],
    });
    expect(text).toContain("2 change(s)");
    expect(text).toContain("1 conflict");
    expect(text).toContain("c.txt");
    expect(text).toContain("d.txt");
  });

  it("empty report reads as no changes", async () => {
    const { formatMergeReport } = await import("./shadow");
    const text = formatMergeReport({ copied: [], conflicts: [], deletedInShadow: [] });
    expect(text).toContain("Nothing to merge");
  });
});

// ── helpers ────────────────────────────────────────────────────────────

/** Bypass IPC: seed the resident map the way shadowStatus would. */
async function createShadowForTest(): Promise<void> {
  const { native } = await import("./native");
  const orig = native.shadowStatus;
  (native as { shadowStatus: unknown }).shadowStatus = async () => ({
    projectRoot: REAL,
    shadowRoot: "C:/Users/me/.kai/shadow/1234abcd",
    createdAtMs: 0,
    sharedDirs: [],
  });
  try {
    await loadShadow(REAL);
  } finally {
    (native as { shadowStatus: unknown }).shadowStatus = orig;
  }
}
