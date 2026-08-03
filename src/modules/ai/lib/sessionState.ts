import type { UIMessage } from "@ai-sdk/react";
import type { FileSnapshot } from "./fileTracker";
import { getTodos } from "../store/todoStore";

// ── Types ─────────────────────────────────────────────────────────────

type SessionStateInput = {
  /** Full conversation messages (before trimming). */
  messages: UIMessage[];
  /** Files tracked during this session. */
  fileSnapshot: FileSnapshot[];
  /** Active session id for retrieving todos. */
  sessionId: string | null;
};

// ── Builders ──────────────────────────────────────────────────────────

/** Extract the user's task from the first user message. */
function extractTask(messages: UIMessage[]): string | null {
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const p of m.parts) {
      if (p.type !== "text") continue;
      const text = (p as { text: string }).text
        .replace(/<env>[\s\S]*?<\/env>/g, "")
        .replace(/<selection[\s\S]*?<\/selection>/g, "")
        .replace(/<file[\s\S]*?<\/file>/g, "")
        .replace(/<snippet[\s\S]*?<\/snippet>/g, "")
        .trim();
      if (!text) continue;
      // Take the first line, clamp to 120 chars.
      const first = text.split("\n")[0].trim();
      return first.length > 120 ? `${first.slice(0, 120)}…` : first;
    }
  }
  return null;
}

/** Lightweight scan for patterns that look like errors encountered. */
function extractErrorHints(messages: UIMessage[]): string[] {
  const hints: string[] = [];
  const seen = new Set<string>();
  const ERROR_PATTERNS = [
    /\b(error|exception|failed|failure|cannot|could not|unable to|timeout|rejected|denied)\b[^.!?\n]{10,120}/gi,
    /\b(TS\d{4}|E\d{4,}|TypeError|SyntaxError|ReferenceError|RangeError)\b[^.!?\n]{5,120}/gi,
    /\bpanic|SIGSEGV|segfault|OOM|out of memory\b[^.!?\n]{5,80}/gi,
  ];

  // Only scan the last 30 messages for efficiency.
  const recent = messages.slice(-30);
  for (const m of recent) {
    if (m.role !== "assistant") continue;
    for (const p of m.parts) {
      if (p.type !== "text") continue;
      const text = (p as { text: string }).text;
      for (const re of ERROR_PATTERNS) {
        let match: RegExpExecArray | null;
        while ((match = re.exec(text)) !== null) {
          const hint = match[0].trim();
          const key = hint.slice(0, 60).toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            hints.push(hint.slice(0, 120));
          }
        }
      }
    }
  }
  return hints.slice(0, 5); // max 5 error hints
}

/** Format the todo list as a compact checklist. */
function formatTodos(sessionId: string | null): string | null {
  if (!sessionId) return null;
  const todos = getTodos(sessionId);
  if (todos.length === 0) return null;

  const statusIcon = (s: string) =>
    s === "completed" ? "✅" : s === "in_progress" ? "⏳" : "⬜";

  const lines = todos.map((t) => {
    const icon = statusIcon(t.status);
    return `${icon} ${t.title}`;
  });

  return lines.join("\n");
}

/** Format the file snapshot. Groups by state, limits to 30 entries. */
function formatFiles(snapshot: FileSnapshot[]): string | null {
  if (snapshot.length === 0) return null;

  const modified = snapshot.filter((f) => f.state === "modified");
  const read = snapshot.filter((f) => f.state === "read");

  const lines: string[] = [];

  // Show modified files first (more important), limited to 15.
  for (const f of modified.slice(0, 15)) {
    lines.push(`- \`${f.path}\` — edited`);
  }
  if (modified.length > 15) {
    lines.push(`- … and ${modified.length - 15} more edited files`);
  }

  // Then show read files, limited to 10.
  for (const f of read.slice(0, 10)) {
    lines.push(`- \`${f.path}\` — read`);
  }
  if (read.length > 10 && modified.length <= 15) {
    lines.push(`- … and ${read.length - 10} more files read`);
  }

  return lines.join("\n");
}

// ── Main export ───────────────────────────────────────────────────────

/**
 * Build a deterministic session state snapshot from structured data
 * we already track — no model call needed. Used to compress old
 * conversation history when context is running low.
 */
export function buildSessionState(input: SessionStateInput): string {
  const sections: string[] = [];

  const task = extractTask(input.messages);
  if (task) {
    sections.push(`## Task\n${task}`);
  }

  const files = formatFiles(input.fileSnapshot);
  if (files) {
    sections.push(`## Files touched\n${files}`);
  }

  const todos = formatTodos(input.sessionId);
  if (todos) {
    sections.push(`## Plan\n${todos}`);
  }

  const errors = extractErrorHints(input.messages);
  if (errors.length > 0) {
    sections.push(`## Errors encountered\n${errors.map((e) => `- ${e}`).join("\n")}`);
  }

  if (sections.length === 0) {
    return "No state tracked yet.";
  }

  return `<session_state>\n${sections.join("\n\n")}\n</session_state>`;
}
