import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseChangelogSection,
  parseReleaseNotes,
} from "./parseChangelog";

/**
 * Changelog-rendering contract — the 2.0.0 regression.
 *
 * User report: "Last time on 2.0.0 release the Update and Restart popup
 * didn't render the changelog text for some reason."
 *
 * Postmortem (verified against the shipped artifacts): latest.json for
 * v2.0.0 carried `notes: ""` — tauri-action derives that field from the
 * release body but did NOT propagate it (release body on GitHub held 2184
 * chars; the updater JSON held none). The dialog's fallback then read
 * CHANGELOG.md from the CWD / exe directory — which doesn't exist in an
 * INSTALLED app because the file was never bundled. Both sources empty →
 * no changelog section rendered.
 *
 * The three fixes pinned here:
 *   1. The release workflow's patch-notes job injects the changelog into
 *      latest.json's notes when empty (root cause).
 *   2. CHANGELOG.md is bundled as a resource and fs_read_changelog resolves
 *      it via the Tauri resource dir (fallback actually works installed).
 *   3. The dialog resets changelog state per status change (no stale
 *      sections from a previous version's offer).
 */

const read = (p: string) =>
  readFileSync(new URL(p, import.meta.url), "utf8");

describe("parser handles every shipped notes shape", () => {
  it("parses the ACTUAL v2.0.0 release body (flat bullets, no headings)", () => {
    const flatBody = [
      "- Group chats: added cross-project group chats where multiple agents coordinate.",
      "- Agent OS: themed \"needs input\" dot in the project rail.",
      "",
      "- Build: pinned staticVCRuntime and upgraded the Tauri CLI.",
    ].join("\n");
    const sections = parseReleaseNotes(flatBody);
    expect(sections).toHaveLength(1);
    expect(sections[0].body).toHaveLength(3);
  });

  it("parses an empty-string notes field into zero sections (never crashes)", () => {
    expect(parseReleaseNotes("")).toEqual([]);
    expect(parseReleaseNotes("   \n  \n")).toEqual([]);
  });

  it("extracts the bundled CHANGELOG.md section for the offered version", () => {
    const changelog = read("../../../CHANGELOG.md");
    const sections = parseChangelogSection(changelog, "2.0.0");
    expect(sections.length).toBeGreaterThan(0);
    const flat = sections.flatMap((s) => s.body);
    expect(flat.length).toBeGreaterThan(5);
    // The changelog's own format contract: flat bullets, "Area: summary".
    expect(flat[0]).toMatch(/^[A-Z][\w/ ]+: /);
  });

  it("falls back to the top-most section for an unknown version", () => {
    const changelog = read("../../../CHANGELOG.md");
    const sections = parseChangelogSection(changelog, "9.9.9");
    expect(sections.length).toBeGreaterThan(0);
  });
});

describe("the rendered dialog consults both sources", () => {
  const dialog = read("./UpdaterDialog.tsx");

  it("prefers the updater notes and falls back to the bundled changelog", () => {
    expect(dialog).toContain("status.update?.body?.trim()");
    expect(dialog).toContain('invoke<string>("fs_read_changelog")');
    // The fallback only renders NON-empty parses (never a blank box).
    expect(dialog).toContain("sections.length > 0 ? sections : null");
  });

  it("resets changelog state per status change (no stale sections)", () => {
    expect(dialog).toContain(
      "setChangelog({ loading: true, sections: null });",
    );
  });
});

describe("the fallback reads a BUNDLED resource (works installed)", () => {
  it("fs_read_changelog resolves the Tauri resource dir first", () => {
    const file = read("../../../src-tauri/src/modules/fs/file.rs");
    expect(file).toContain("BaseDirectory::Resource");
    expect(file).toContain("resolve(\"CHANGELOG.md\"");
  });

  it("CHANGELOG.md is declared as a bundle resource", () => {
    const conf = read("../../../src-tauri/tauri.conf.json");
    expect(conf).toContain('"../CHANGELOG.md": "CHANGELOG.md"');
  });
});

describe("the release workflow patches empty notes (root-cause fix)", () => {
  const workflow = read("../../../.github/workflows/release.yml");

  it("has a patch-notes job running after the builds", () => {
    expect(workflow).toContain("patch-notes:");
    expect(workflow).toMatch(
      /patch-notes:\s*\n\s*needs: \[create-release, publish-tauri\]/,
    );
  });

  it("injects the changelog body when latest.json notes is empty", () => {
    expect(workflow).toContain("json.notes = body;");
    expect(workflow).toMatch(
      /if \(notes\) \{\s*\n\s*core\.info\(`latest\.json notes already populated/,
    );
  });

  it("fails the release when the changelog has no section for the tag", () => {
    expect(workflow).toContain(
      "core.setFailed('Release body is empty - CHANGELOG.md has no section for this tag.",
    );
  });
});
