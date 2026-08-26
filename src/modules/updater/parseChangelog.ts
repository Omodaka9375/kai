//! Parse a `CHANGELOG.md` and return the bullet list for a newer version.
//!
//! CHANGELOG sections are formatted like:
//!   ## [1.1.9]
//!   ### Added
//!   - **title**: summary text
//!   - more text
//!
//! Returns: `{ section: "Added" | "Fixed" | ..., lines: string[] }`.
//! Falls back to the top-most section when a specific version is not
//! referenced explicitly.

export type ChangelogSection = {
  title: string;
  body: string[];
};

/** Parse `CHANGELOG.md` for the version block. */
export function parseChangelogSection(text: string, version: string) {
  // Strip the common top-of-file marker too.
  const lines = text.split(/\r?\n/);
  let inTarget = false;
  let section: ChangelogSection | null = null;
  const out: ChangelogSection[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## [")) {
      if (inTarget) break;
      inTarget = trimmed === `[${version}]`;
    }
    if (inTarget) {
      if (trimmed.startsWith("### ")) {
        if (section) out.push(section);
        section = { title: trimmed.slice(4), body: [] };
        continue;
      }
      if (section && trimmed.startsWith("- ") && section.title) {
        section.body.push(trimmed.slice(2));
      }
    }
  }
  if (section) out.push(section);
  return out;
}
