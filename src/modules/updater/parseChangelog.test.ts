import { describe, expect, it } from "vitest";
import { parseChangelogSection, parseReleaseNotes } from "./parseChangelog";

describe("parseChangelogSection", () => {
  const changelog = [
    "# Changelog",
    "",
    "## [1.2.2]",
    "",
    "### Added",
    "",
    "- **MCP server diagnostics**: stderr is now piped.",
    "",
    "### Fixed",
    "",
    "- **Escape stopped the agent**",
    "",
    "---",
    "",
    "## [1.2.1]",
    "",
    "### Added",
    "",
    "- **Old feature**: should not appear.",
    "",
  ].join("\n");

  it("extracts the matching version's sections only", () => {
    const sections = parseChangelogSection(changelog, "1.2.2");
    expect(sections).toEqual([
      {
        title: "Added",
        body: ["**MCP server diagnostics**: stderr is now piped."],
      },
      { title: "Fixed", body: ["**Escape stopped the agent**"] },
    ]);
  });

  it("stops at the next version heading", () => {
    const sections = parseChangelogSection(changelog, "1.2.2");
    const flat = sections.flatMap((s) => s.body).join("\n");
    expect(flat).not.toContain("Old feature");
  });

  it("handles Windows line endings", () => {
    const crlf = changelog.replace(/\n/g, "\r\n");
    const sections = parseChangelogSection(crlf, "1.2.2");
    expect(sections[0].title).toBe("Added");
  });

  it("returns empty for a missing version", () => {
    expect(parseChangelogSection(changelog, "9.9.9")).toEqual([]);
  });

  it("collects flat bullets with no ### subheading into one untitled section (current CHANGELOG format)", () => {
    // The 1.5.x entries are flat `-` bullet lists directly under the
    // version heading — no `### Added` subheadings. Regression: these were
    // silently dropped, leaving the updater popup empty.
    const flat = [
      "# Changelog",
      "",
      "## [1.5.5]",
      "",
      "- AI: `/compact` — reset the context in place in the same chat.",
      "- AI: agents can now register MCP servers.",
      "",
      "---",
      "",
      "## [1.5.4]",
      "",
      "- AI: `look_at_screen` — the agent can now see your displays.",
      "",
    ].join("\n");

    const sections = parseChangelogSection(flat, "1.5.5");
    expect(sections).toEqual([
      {
        title: "",
        body: [
          "AI: `/compact` — reset the context in place in the same chat.",
          "AI: agents can now register MCP servers.",
        ],
      },
    ]);
    // Must not bleed into 1.5.4.
    const flatBodies = sections.flatMap((s) => s.body).join("\n");
    expect(flatBodies).not.toContain("look_at_screen");
  });
});

describe("parseReleaseNotes", () => {
  it("parses a GitHub release body (no version marker)", () => {
    const body = [
      "### Added",
      "- **MCP server diagnostics**: stderr is now piped.",
      "",
      "### Fixed",
      "- **Escape stopped the agent**",
      "- **Git Graph opened the wrong history**",
    ].join("\r\n");

    expect(parseReleaseNotes(body)).toEqual([
      {
        title: "Added",
        body: ["**MCP server diagnostics**: stderr is now piped."],
      },
      {
        title: "Fixed",
        body: [
          "**Escape stopped the agent**",
          "**Git Graph opened the wrong history**",
        ],
      },
    ]);
  });

  it("handles a flat bullet-only body (no section headings)", () => {
    // Some release bodies skip `###` headers entirely — collect them into
    // one untitled section instead of dropping everything.
    const body = "- Fixed a crash\r\n- Added a feature\n";
    expect(parseReleaseNotes(body)).toEqual([
      { title: "", body: ["Fixed a crash", "Added a feature"] },
    ]);
  });
});
