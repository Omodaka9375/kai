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

/**
 * GitHub rejects issue-prefill URLs above ~8 KB with "Your request URL is too
 * long". Keep the whole URL safely under this so "Report an issue" never dies
 * on a large log tail / crash snapshot.
 */
export const MAX_ISSUE_URL_BYTES = 7800;

/**
 * Trim `body` so `encodeURIComponent(body)` fits within `budget` bytes,
 * preserving the leading environment block and dropping from the tail (the
 * log tail is cut first, then the crash snapshot).
 */
export function fitBodyForUrl(body: string, budget: number): string {
  const cap = Math.max(0, budget);
  if (encodeURIComponent(body).length <= cap) return body;

  // Binary search for the longest prefix whose encoded form fits. The encoded
  // length is monotonic in the raw prefix length.
  let lo = 0;
  let hi = body.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (encodeURIComponent(body.slice(0, mid)).length <= cap) lo = mid;
    else hi = mid - 1;
  }

  // Don't split a surrogate pair — encodeURIComponent throws on lone surrogates.
  while (lo > 0) {
    const prev = body.charCodeAt(lo - 1);
    const curr = body.charCodeAt(lo);
    if (prev >= 0xd800 && prev <= 0xdbff && curr >= 0xdc00 && curr <= 0xdfff) {
      lo--;
    } else {
      break;
    }
  }

  return body.slice(0, lo);
}

export const diagnostics = {
  collect: () => invoke<DiagnosticsBundle>("diagnostics_collect"),
};
