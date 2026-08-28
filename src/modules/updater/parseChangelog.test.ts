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
    // Some release bodies skip `###` headers entirely.
    const body = "- Fixed a crash\n- Added a feature\n";
    expect(parseReleaseNotes(body)).toEqual([]);
  });
});
