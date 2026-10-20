/**
 * Dropped-text sanitization for the terminal drop target.
 *
 * The drop target accepts ANY text/plain drag — including external ones
 * from the browser or other apps — and writes the payload into the PTY
 * as if typed. That makes two raw-payload hazards:
 *   - a newline auto-executes at a bash/zsh prompt (LF == Enter);
 *   - control bytes (NUL, DEL, tab-completion triggers) have no business
 *     arriving at a prompt uninvited.
 * Internal explorer drags carry shell-quoted relative paths and pass
 * through unchanged.
 */

/** Sanitize text pulled from a drop event before it is written to the PTY. */
export function sanitizeDroppedText(raw: string): string {
  // CR is meaningless as input (it is the Windows Enter key — we send it
  // ourselves via the keyboard path, never via insertion).
  let text = raw.replace(/\r/g, "");
  // Newlines would auto-execute at a bash/zsh prompt — join instead.
  text = text.replace(/\n+/g, " ");
  // Strip remaining control bytes (NUL, tab, ESC, DEL, …).
  return text.replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, "").trim();
}
