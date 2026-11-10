import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/** Small source contracts for composer state that is shared across projects.
 *  2026-11-10 audit: switching sessions used to send the previous chat's
 *  pending files, and picking one file twice produced colliding React keys.
 */
const composer = readFileSync(new URL("./composer.tsx", import.meta.url), "utf8");

describe("composer attachment isolation", () => {
  it("clears pending files when the session changes", () => {
    const branch = composer.slice(
      composer.indexOf("if (draftSessionRef.current !== sessionId)"),
      composer.indexOf("if (!sessionId) return;", composer.indexOf("if (draftSessionRef.current !== sessionId)")),
    );
    expect(branch).toContain("setValue(");
    expect(branch).toContain("setFiles([]);");
  });

  it("deduplicates picked files by their existing attachment id", () => {
    const addFiles = composer.slice(
      composer.indexOf("const addFiles = async"),
      composer.indexOf("const removeFile", composer.indexOf("const addFiles = async")),
    );
    expect(addFiles).toContain("const ids = new Set(prev.map((f) => f.id));");
    expect(addFiles).toContain("next.filter((f) => !ids.has(f.id))");
  });
});
