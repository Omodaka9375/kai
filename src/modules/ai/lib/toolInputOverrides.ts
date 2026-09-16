/**
 * Edited tool-input overrides — lets the approval card swap the input a tool
 * executes with after the user edits the proposed command/entry in the card.
 *
 * The AI SDK's approval response cannot carry a modified input, so the edit
 * travels out-of-band: the card registers the edited input keyed by
 * `toolCallId` (available on every ToolUIPart) at approval time, and the
 * tool's `execute` consumes it via `options.toolCallId`.
 *
 * Entries are consumed exactly once (by the executing tool) and evicted
 * insertion-order beyond the cap, so a session that never executes (stopped
 * before resume) cannot grow the map unboundedly.
 */

const MAX_OVERRIDES = 32;

const overrides = new Map<string, Record<string, unknown>>();

export function setEditedToolInput(
  toolCallId: string,
  input: Record<string, unknown>,
): void {
  overrides.delete(toolCallId);
  overrides.set(toolCallId, input);
  while (overrides.size > MAX_OVERRIDES) {
    const oldest = overrides.keys().next().value;
    if (oldest === undefined) break;
    overrides.delete(oldest);
  }
}

/** Take the edited input for a tool call, or null if none was registered. */
export function consumeEditedToolInput(
  toolCallId: string,
): Record<string, unknown> | null {
  const value = overrides.get(toolCallId);
  if (value === undefined) return null;
  overrides.delete(toolCallId);
  return value;
}
