/**
 * REPLY STYLE (2026-11-19): four structured "how to write to me" fields
 * under Settings -> Agents -> Custom instructions, rendered into a compact
 * deterministic prompt block appended next to the user's custom
 * instructions. Inspired by the HUMANS.md 0.3 draft (humansmd.dev) - a
 * profile of how the user wants agents to write to them: TL;DR first, a
 * word cap, questions batched at the end of the task, interrupts only when
 * blocked.
 *
 * FORM, NEVER PERMISSION: the block shapes replies only. It never grants
 * tool rights or overrides the harness's approval gates - the header says
 * so explicitly. All fields are optional; with everything off/empty the
 * block is omitted entirely and prompts stay byte-identical to before
 * (prefix-cache friendly).
 */

export type ReplyStyle = {
  /** Start every reply with a one-line TL;DR. */
  leadWithTldr: boolean;
  /** Optional word cap for the entire reply (20-2000, per the HUMANS.md
   *  draft range). 0 = no cap. */
  maxWords: number;
  /** How open questions reach the user: during the task, or collected at
   *  the end with a recommended pick each. */
  questionStyle: "as_they_come" | "end_of_task";
  /** Interrupt the user mid-task only when work cannot continue;
   *  everything else waits. */
  interruptOnlyWhenBlocked: boolean;
};

export const DEFAULT_REPLY_STYLE: ReplyStyle = {
  leadWithTldr: false,
  maxWords: 0,
  questionStyle: "as_they_come",
  interruptOnlyWhenBlocked: false,
};

/** Normalize a stored value back into the valid domain (bad persisted data
 *  must never wedge the prompt block). */
export function sanitizeReplyStyle(raw: Partial<ReplyStyle> | null | undefined): ReplyStyle {
  const r = raw ?? {};
  const maxWords =
    typeof r.maxWords === "number" && Number.isFinite(r.maxWords)
      ? Math.min(2000, Math.max(0, Math.round(r.maxWords)))
      : DEFAULT_REPLY_STYLE.maxWords;
  return {
    leadWithTldr: r.leadWithTldr === true,
    maxWords,
    questionStyle:
      r.questionStyle === "end_of_task"
        ? "end_of_task"
        : DEFAULT_REPLY_STYLE.questionStyle,
    interruptOnlyWhenBlocked: r.interruptOnlyWhenBlocked === true,
  };
}

/** Anything set? Everything default means no block at all. */
export function replyStyleActive(s: ReplyStyle): boolean {
  return (
    s.leadWithTldr ||
    s.maxWords > 0 ||
    s.questionStyle !== "as_they_come" ||
    s.interruptOnlyWhenBlocked
  );
}

/**
 * Render the prompt block. Deterministic order (stable prefix bytes for
 * provider prompt caching). Empty when nothing is set.
 */
export function formatReplyStyleBlock(s: ReplyStyle): string {
  if (!replyStyleActive(s)) return "";
  const lines: string[] = [];

  if (s.leadWithTldr) {
    lines.push("- Start every reply with a one-line TL;DR of the outcome.");
  }
  if (s.maxWords > 0) {
    lines.push(
      `- Keep the ENTIRE reply under ${s.maxWords} words. Compression never hides failures, skipped steps, risks, or decisions the user must make - put those first, and if you had to leave things out, say how many.`,
    );
  }
  if (s.questionStyle === "end_of_task") {
    lines.push(
      "- Do NOT stop mid-task to ask questions. Collect open questions and batch them at the END of the task, each with your recommended pick, so a plain yes approves it. Reversible choices you are already allowed to make: just make them and report them at the end.",
    );
  }
  if (s.interruptOnlyWhenBlocked) {
    lines.push(
      "- Interrupt the user ONLY when work cannot continue (missing credentials, a blocker no tool call can resolve). Everything else waits for the end of the task. Unsaved/uncommitted user work is never at risk either way.",
    );
  }

  return [
    "## USER REPLY STYLE - how to write to me",
    "Preferences only - these shape HOW you write to the user. They never grant permissions or override approval gates, repository rules, or explicit instructions.",
    ...lines,
  ].join("\n");
}
