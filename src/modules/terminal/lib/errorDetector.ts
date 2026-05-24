/**
 * Watches decoded terminal text for common error patterns and dispatches
 * a `kai:terminal-error` CustomEvent when one is detected.
 */

const ERROR_PATTERNS: RegExp[] = [
  // Generic
  /\bError:\s/i,
  /\bERROR\b/,
  /\bFAILED\b/,
  /\bFATAL\b/i,
  /\bPANIC\b/i,
  // Node / npm / pnpm
  /\bERR!\b/,
  /\bUnhandledPromiseRejection\b/,
  /\bSyntaxError\b/,
  /\bReferenceError\b/,
  /\bTypeError\b/,
  // Rust / cargo
  /^error\[E\d{4}\]/m,
  /\bcannot find\b.*\bin scope\b/,
  // Python
  /\bTraceback \(most recent call last\)/,
  /\bModuleNotFoundError\b/,
  /\bImportError\b/,
  // Git
  /^fatal:/m,
  // Build tools
  /\bBuild failed\b/i,
  /\bCompilation failed\b/i,
  /\bexited with code [1-9]/i,
  /\bexit code [1-9]/i,
];

/** Patterns to ignore (false positives from normal output). */
const IGNORE_PATTERNS: RegExp[] = [
  /\berror\.\w+/i, // e.g. "error.ts", "error.message"
  /\.error\b/i,    // e.g. "console.error"
  /errors?: 0\b/i, // e.g. "0 errors"
];

const DEBOUNCE_MS = 10_000;
const BUFFER_MAX = 4000;

let textBuffer = "";
let lastErrorAt = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/** Feed decoded text from the PTY into the detector. */
export function feedText(text: string): void {
  textBuffer += text;
  // Keep buffer bounded — only care about recent output.
  if (textBuffer.length > BUFFER_MAX) {
    textBuffer = textBuffer.slice(-BUFFER_MAX);
  }

  if (debounceTimer) return;

  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    checkForErrors();
  }, 300);
}

function checkForErrors(): void {
  const now = Date.now();
  if (now - lastErrorAt < DEBOUNCE_MS) {
    textBuffer = "";
    return;
  }

  // Check the last chunk of text for error patterns.
  const chunk = textBuffer;
  textBuffer = "";

  for (const ignore of IGNORE_PATTERNS) {
    if (ignore.test(chunk)) return;
  }

  for (const pattern of ERROR_PATTERNS) {
    const match = pattern.exec(chunk);
    if (match) {
      lastErrorAt = now;
      // Extract context: a few lines around the match.
      const lines = chunk.split("\n");
      const matchLine = chunk.slice(0, match.index).split("\n").length - 1;
      const start = Math.max(0, matchLine - 2);
      const end = Math.min(lines.length, matchLine + 8);
      const context = lines.slice(start, end).join("\n").trim();

      window.dispatchEvent(
        new CustomEvent("kai:terminal-error", {
          detail: { context, pattern: match[0] },
        }),
      );
      return;
    }
  }
}

/** Reset detector state (e.g. on session switch). */
export function resetDetector(): void {
  textBuffer = "";
  lastErrorAt = 0;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}
