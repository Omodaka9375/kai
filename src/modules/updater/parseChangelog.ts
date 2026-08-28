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

  for (const line of lines) {
    const trimmed = line.trim();

    if (!active) {
      if (trimmed === target) active = true;
      continue;
    }

    // Stop at the next version heading so we never bleed into another release.
    if (trimmed.startsWith("## [")) break;

    if (trimmed.startsWith("### ")) {
      if (section) out.push(section);
      section = { title: trimmed.slice(4).trim(), body: [] };
      continue;
    }

    if (section && (trimmed.startsWith("- ") || trimmed.startsWith("* "))) {
      const body = trimmed.slice(2).trim();
      if (body) section.body.push(body);
    }
  }

  if (section) out.push(section);
  return out;
}

/**
 * Parse a GitHub release body / `latest.json` notes field — markdown with
 * `###`-headed sections and `-` bullets, no version marker. Every `###`
 * heading begins a section; bullets outside a section are ignored.
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

    if (section && (trimmed.startsWith("- ") || trimmed.startsWith("* "))) {
      const body = trimmed.slice(2).trim();
      if (body) section.body.push(body);
    }
  }

  if (section) out.push(section);
  return out;
}
