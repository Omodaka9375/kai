/**
 * Watches decoded terminal text for common error patterns and dispatches
 * a `kai:terminal-error` CustomEvent when one is detected.
 */

const ERROR_PATTERNS: RegExp[] = [
  // Generic — require word boundary and context
  /\bError:\s+\S/i, // "Error: something" not "Error:" in isolation
  /\bERROR\b[:\s]/i, // "ERROR:" or "ERROR " with context
  /\bFAILED\b[:\s]/i, // "FAILED:" or "FAILED " with context
  /\bFATAL\b[:\s]/i,
  /\bPANIC\b[:\s]/i,
  // Node / npm / pnpm
  /npm ERR!/, // npm error format
  /pnpm ERR!/, // pnpm error format
  /\bUnhandledPromiseRejection\b/,
  /\bSyntaxError\b[:\s]/,
  /\bReferenceError\b[:\s]/,
  /\bTypeError\b[:\s]/,
  // Rust / cargo
  /^error\[E\d{4}\]/m,
  /\bcannot find\b.*\bin scope\b/,
  // Python
  /Traceback \(most recent call last\)/,
  /\bModuleNotFoundError\b[:\s]/,
  /\bImportError\b[:\s]/,
  // Git
  /^fatal:\s/m,
  // Build tools
  /\bBuild failed\b[:\s]/i,
  /\bCompilation failed\b[:\s]/i,
  /\bexited with code\s+[1-9]/i,
  /\bexit code\s+[1-9]/i,
];

/** Patterns to ignore (false positives from normal output). */
const IGNORE_PATTERNS: RegExp[] = [
  /\berror\.\w+/i, // e.g. "error.ts", "error.message"
  /\.error\b/i,    // e.g. "console.error"
  /errors?: 0\b/i, // e.g. "0 errors"
  // Documentation / help text
  /\berror:\s+see\s+documentation/i,
  /\berror:\s+for\s+more\s+info/i,
  /\berror:\s+reference\b/i,
  // PowerShell / Windows common messages
  /\bthe term\s+is not recognized\b/i,
  /\bcannot be found\b/i,
  /\bnamed\s+command\b/i,
  // Build / test success messages that mention errors
  /\bno errors? found\b/i,
  /\b0 errors?\b/i,
  /\bpassed\b.*\b0 errors?\b/i,
  // Test output that mentions errors but isn't failing
  /\bexpected error\b/i,
  /\bcaught error\b/i,
  /\berror was expected\b/i,
  // Common false positives
  /\bignore error\b/i,
  /\bsuppress error\b/i,
  /\berror handler\b/i,
  /\berror logging\b/i,
  /\berror checking\b/i,
  /\berror handling\b/i,
  /\berror message\b/i,
  /\berror code\b/i,
  /\berror status\b/i,
  /\berror reporting\b/i,
  // npm/pnpm info messages (not errors)
  /\bnotice\b/i,
  /\binfo\b(?!.*(ERR|failed|error))/i,
  // Git info/help
  /^fatal:.*\b(use|--help|configuration|repository)/i,
  // Package manager info
  /\bno error found\b/i,
  /\bno errors? detected\b/i,
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
