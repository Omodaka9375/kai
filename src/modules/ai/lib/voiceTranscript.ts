/**
 * Voice-transcript routing (2026-11-02 cross-project paste fix).
 *
 * User report: dictated a long note, switched projects while the STT was
 * still transcribing, and the transcript pasted into the OTHER project's
 * input bar. The composer is a single app-level provider whose text follows
 * the GLOBAL active session — so a result arriving after a switch lands in
 * whatever project is now visible (and, with hands-free auto-submit on,
 * would even be SENT to that project's agent).
 *
 * The fix: snapshot the chat session the capture STARTED in, and when the
 * transcript arrives route it to THAT session's persisted draft if the user
 * has since moved on. Switching back shows the transcript waiting in the
 * original chat's input; the visible project is never polluted.
 */

export type VoiceTranscriptRouting =
  | { route: "field" }
  | { route: "draft"; sessionId: string };

/** Decide where a finished transcript goes.
 *  - `field`: paste into the visible input as before — the capture's session
 *    is still the active one (or the capture predates the snapshot, e.g. a
 *    legacy caller), so the user is looking at the right chat.
 *  - `draft`: the user switched projects/chats mid-transcription — land the
 *    transcript in the CAPTURED session's persisted draft instead. */
export function routeVoiceTranscript(
  capturedSessionId: string | null | undefined,
  activeSessionId: string | null | undefined,
): VoiceTranscriptRouting {
  if (
    !capturedSessionId ||
    !activeSessionId ||
    capturedSessionId === activeSessionId
  ) {
    return { route: "field" };
  }
  return { route: "draft", sessionId: capturedSessionId };
}

/** Merge a transcript onto a session's existing draft text ("typed before
 *  capture started"), matching the in-field paste format. */
export function mergeDraftTranscript(
  existing: string | null | undefined,
  transcript: string,
): string {
  const pre = (existing ?? "").trim();
  return pre ? `${pre} ${transcript}` : transcript;
}
