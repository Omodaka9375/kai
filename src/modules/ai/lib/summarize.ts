import { generateText, type LanguageModel, type ModelMessage } from "ai";

const SUMMARIZE_PROMPT = `You are a conversation summarizer for an AI coding assistant. Your job is to compress a conversation into a structured summary that preserves all information the assistant needs to continue working effectively.

Analyze the conversation and produce a summary in EXACTLY this format:

## Task
One or two sentences describing what the user is working on and their goal.

## Key Decisions
- Bullet list of important choices made (tech stack, architecture, approach, naming, etc.)
- Include decisions the user explicitly rejected so the assistant doesn't re-suggest them.

## Files Touched
- \`path/to/file\` — brief description of what was done (created, edited, read, deleted)
- Only include files that are relevant to ongoing work.

## Current State
What's done, what's in progress, what's pending. Be specific — mention function names, variable names, line numbers if relevant.

## Errors & Fixes
- Any errors encountered and how they were resolved.
- Failed approaches that should not be retried.

Rules:
- Be concise but preserve ALL actionable details.
- Never omit file paths, command outputs, or error messages that might be needed.
- If a TODO list or plan exists, include its current state.
- Output ONLY the summary — no preamble, no explanation.`;

/** Number of trailing user/assistant message pairs to keep verbatim. */
export const SUMMARY_KEEP_TAIL_PAIRS = 6;

/**
 * Call the model to summarize the conversation history.
 * Returns a structured markdown summary string.
 */
export async function summarizeConversation(
  messages: ModelMessage[],
  model: LanguageModel,
  abortSignal?: AbortSignal,
): Promise<string> {
  // Build a condensed transcript for the summarizer. Skip the system
  // message (index 0) — the summarizer doesn't need the full system prompt.
  const transcript = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      const role = m.role === "user" ? "User" : "Assistant";
      if (typeof m.content === "string") return `${role}: ${m.content}`;
      if (Array.isArray(m.content)) {
        const parts = (m.content as { type: string; text?: string; toolName?: string; output?: unknown }[])
          .map((p) => {
            if (p.type === "text" && p.text) return p.text;
            if (p.type === "tool-call") return `[tool call: ${p.toolName}]`;
            if (p.type === "tool-result") {
              const out = p.output;
              const str = typeof out === "string" ? out : JSON.stringify(out);
              // Truncate very large tool results in the transcript to save tokens.
              return `[tool result: ${str.length > 500 ? str.slice(0, 500) + "…" : str}]`;
            }
            return "";
          })
          .filter(Boolean);
        return `${role}: ${parts.join("\n")}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");

  const { text } = await generateText({
    model,
    messages: [
      { role: "system", content: SUMMARIZE_PROMPT },
      {
        role: "user",
        content: `Summarize this conversation:\n\n${transcript}`,
      },
    ],
    maxOutputTokens: 2048,
    abortSignal,
  });

  return text.trim();
}

/**
 * Find the index where we should split: keep the last N user/assistant
 * pairs (counting from the end), drop everything before that.
 * Returns the index of the first message to keep.
 */
export function findTailCutoff(
  messages: ModelMessage[],
  keepPairs: number,
): number {
  let pairs = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") pairs++;
    if (pairs >= keepPairs) return i;
  }
  return 0;
}
