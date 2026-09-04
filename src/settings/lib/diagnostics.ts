import { invoke } from "@tauri-apps/api/core";

export type DiagnosticsBundle = {
  version: string;
  os: string;
  arch: string;
  logDir: string;
  logTail: string;
  crash: string | null;
};

/** Redact obvious secrets and the user's home path from a diagnostics blob. */
export function redactDiagnostics(text: string, home: string | null): string {
  let out = text;

  // Strip the user's home directory so an issue doesn't leak their username.
  if (home) {
    const normalized = home.replace(/\\/g, "/").replace(/\/$/, "");
    const variants = [normalized, home.replace(/\//g, "\\")];
    for (const v of variants) {
      if (!v) continue;
      // Case-insensitive on Windows.
      const re = new RegExp(
        v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "gi",
      );
      out = out.replace(re, "~");
    }
  }

  // Redact common secret shapes: bearer tokens, api keys, keyring values.
  out = out
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "sk-***")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1***")
    .replace(/(api[_-]?key\s*[:=]\s*)[A-Za-z0-9._~+/=-]{8,}/gi, "$1***")
    .replace(/(token\s*[:=]\s*)[A-Za-z0-9._~+/=-]{8,}/gi, "$1***");

  return out;
}

/** Build a redacted Markdown diagnostics block for the issue body. */
export function buildIssueBody(
  bundle: DiagnosticsBundle,
  home: string | null,
): string {
  const log = redactDiagnostics(bundle.logTail, home);
  const crash = bundle.crash
    ? redactDiagnostics(bundle.crash, home)
    : null;

  const lines: string[] = [
    "### Environment",
    "",
    `- **Version**: ${bundle.version}`,
    `- **OS**: ${bundle.os}`,
    `- **Arch**: ${bundle.arch}`,
    "",
    "### What happened",
    "",
    "<!-- Describe the bug or crash here. -->",
    "",
  ];

  if (crash) {
    lines.push("### Crash snapshot", "", "```", crash, "```", "");
  }

  if (log) {
    lines.push("### Log (tail)", "", "```", log, "```", "");
  }

  return lines.join("\n");
}

export const diagnostics = {
  collect: () => invoke<DiagnosticsBundle>("diagnostics_collect"),
};
