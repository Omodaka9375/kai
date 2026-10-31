//! Parse changelog / release-note text into per-section bullet lists.
//!
//! Two inputs are supported:
//!
//! 1. `CHANGELOG.md` (bundled with the app):
//!    ```
//!    ## [1.2.2]
//!    ### Added
//!    - **title**: summary text
//!    ```
//! 2. GitHub release bodies / updater `latest.json` notes:
//!    ```
//!    ### Added
//!    - **title**: summary text
//!    ```
//!    (no `## [version]` marker — the version is implicit).

export type ChangelogSection = {
  title: string;
  body: string[];
};

/**
 * Parse `CHANGELOG.md` and return the bullet list for a specific version.
 * Falls back to the top-most section when the version isn't referenced.
 */
export function parseChangelogSection(
  text: string,
  version: string,
): ChangelogSection[] {
  const lines = text.split(/\r?\n/);
  const target = `## [${version}]`;
  let active = false;
  let section: ChangelogSection | null = null;
  const out: ChangelogSection[] = [];
  // Fallback accumulation: if no `## [version]` heading matches, keep the
  // TOP-MOST version section (the newest release) so a version-format drift
  // or a missing entry still renders something instead of nothing (the 2.0.0
  // dialog showed no changelog at all when both sources missed).
  let firstVersionIdx = -1;
  const fallbackLines: string[] = [];
  let inFallback = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (!active) {
      if (trimmed === target) {
        active = true;
        continue;
      }
      // First `## [...]` heading encountered = newest section (changelog is
      // newest-first). Capture its body until the next version heading.
      if (
        firstVersionIdx === -1 &&
        trimmed.startsWith("## [") &&
        trimmed.endsWith("]")
      ) {
        firstVersionIdx = i;
        inFallback = true;
        continue;
      }
      if (inFallback) {
        if (trimmed.startsWith("## [")) inFallback = false;
        else fallbackLines.push(lines[i]);
      }
      continue;
    }

    // Stop at the next version heading so we never bleed into another release.
    if (trimmed.startsWith("## [")) break;

    if (trimmed.startsWith("### ")) {
      if (section) out.push(section);
      section = { title: trimmed.slice(4).trim(), body: [] };
      continue;
    }

    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      const body = trimmed.slice(2).trim();
      if (!body) continue;
      // Newer entries are flat bullet lists with no `###` subheadings.
      // Collect them into one untitled section instead of dropping them.
      if (!section) {
        section = { title: "", body: [] };
        out.push(section);
      }
      section.body.push(body);
    }
  }

  if (section && !out.includes(section)) out.push(section);
  if (out.length === 0 && fallbackLines.length > 0) {
    // No exact version match: fall back to the NEWEST section's body so a
    // missing entry or version-format drift still renders something (the
    // 2.0.0 dialog rendered nothing when both sources missed).
    const fallback = parseReleaseNotes(fallbackLines.join("\n"));
    if (fallback.length > 0) return fallback;
  }
  return out;
}

/**
 * Parse a GitHub release body / `latest.json` notes field — markdown with
 * `###`-headed sections and `-` bullets, no version marker. Every `###`
 * heading begins a section; bullets outside a section land in one
 * untitled section (flat bullet-only release notes are common).
 */
export function parseReleaseNotes(text: string): ChangelogSection[] {
  const lines = text.split(/\r?\n/);
  let section: ChangelogSection | null = null;
  const out: ChangelogSection[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("### ")) {
      if (section) out.push(section);
      section = { title: trimmed.slice(4).trim(), body: [] };
      continue;
    }

    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      const body = trimmed.slice(2).trim();
      if (!body) continue;
      if (!section) {
        section = { title: "", body: [] };
        out.push(section);
      }
      section.body.push(body);
    }
  }

  if (section && !out.includes(section)) out.push(section);
  return out;
}
