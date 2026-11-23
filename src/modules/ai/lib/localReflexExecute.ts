/**
 * Local Reflex executor - runs canonical KAI tool calls produced by the
 * Needle fast path through the SAME tool implementations the agent uses
 * (buildCoreTools), with a hard second-layer allowlist. Never imports
 * anything approval-gated: if a tool is missing, lacks execute, or carries
 * needsApproval at runtime, the reflex aborts and the caller falls back to
 * the normal LLM path.
 */
import { buildCoreTools } from "../tools/tools";
import type { ToolContext } from "../tools/context";
import { auditAppend, AUDIT_KINDS } from "./audit";
import { REFLEX_ALLOWED_CANONICAL_TOOLS } from "./localReflex";
import type { CanonicalCall } from "./localReflex";
import type { InferUIMessageChunk, UIMessage } from "ai";

type ExecutableTool = {
  execute?: (input: unknown, options: unknown) => Promise<unknown>;
  needsApproval?: boolean | ((input: unknown, options: unknown) => boolean);
  inputSchema?: {
    safeParse?: (
      input: unknown,
    ) => { success: true; data: unknown } | { success: false };
  };
};

export type ReflexExecResult = {
  ok: boolean;
  /** True when at least one call already executed (partial mutation — caller
   *  must report what ran instead of silently re-running the prompt in the LLM). */
  partial?: boolean;
  /** One line per executed call, for the synthetic assistant message. */
  lines: string[];
};

function isApprovalRequired(tool: ExecutableTool, input: unknown): boolean {
  const na = tool.needsApproval;
  if (typeof na === "function") {
    try {
      return na(input, {}) === true;
    } catch {
      return true;
    }
  }
  return na === true;
}

function isSoftToolFailure(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (typeof r.error === "string" && r.error.trim().length > 0) {
    return r.error;
  }
  if (r.ok === false) {
    return typeof r.note === "string" && r.note.trim().length > 0
      ? r.note
      : "action failed";
  }
  return null;
}

export async function executeReflexCalls(
  calls: CanonicalCall[],
  ctx: ToolContext,
): Promise<ReflexExecResult> {
  if (calls.length === 0) return { ok: false, lines: [] };
  const tools = buildCoreTools(ctx) as unknown as Record<string, ExecutableTool>;

  // Pre-validate EVERY call (allowlist, tool lookup, Zod inputSchema,
  // needsApproval) BEFORE mutating anything, so validation errors never
  // cause partial multi-call execution.
  const prepared: Array<{
    call: CanonicalCall;
    tool: ExecutableTool;
    parsedInput: unknown;
  }> = [];

  for (const call of calls) {
    if (!REFLEX_ALLOWED_CANONICAL_TOOLS.has(call.name)) {
      return { ok: false, lines: [] };
    }
    const tool = tools[call.name];
    if (!tool || typeof tool.execute !== "function") {
      return { ok: false, lines: [] };
    }
    let parsedInput: unknown = call.arguments;
    if (typeof tool.inputSchema?.safeParse === "function") {
      const parsed = tool.inputSchema.safeParse(call.arguments);
      if (!parsed.success) {
        return { ok: false, lines: [] };
      }
      parsedInput = parsed.data;
    }
    if (isApprovalRequired(tool, parsedInput)) {
      return { ok: false, lines: [] };
    }
    prepared.push({ call, tool, parsedInput });
  }

  const lines: string[] = [];
  let succeededCount = 0;

  for (const { call, tool, parsedInput } of prepared) {
    try {
      const result = await tool.execute!(parsedInput, {});
      const softErr = isSoftToolFailure(result);
      if (softErr) {
        if (succeededCount > 0) {
          lines.push(`${call.name}: ${softErr}`);
          return { ok: false, partial: true, lines };
        }
        // First call returned a soft error (e.g. unknown station/persona):
        // nothing mutated yet, so fall through to the LLM cleanly.
        return { ok: false, lines: [] };
      }
      succeededCount++;
      lines.push(
        describeCall(
          call.name,
          (parsedInput && typeof parsedInput === "object"
            ? (parsedInput as Record<string, unknown>)
            : call.arguments),
          result,
        ),
      );
    } catch (e) {
      if (succeededCount > 0) {
        lines.push(`${call.name}: failed (${String(e).slice(0, 120)})`);
        return { ok: false, partial: true, lines };
      }
      return { ok: false, lines: [] };
    }
  }

  auditAppend(
    AUDIT_KINDS.assistantExec,
    "local-reflex",
    `need executed locally: ${calls.map((c) => c.name).join(", ")}`,
    ctx.getWorkspaceRoot() ?? "",
  );
  return { ok: true, lines };
}

/** Compact human-readable line for the synthetic assistant message. */
function describeCall(name: string, args: Record<string, unknown>, result: unknown): string {
  const r = (result ?? {}) as Record<string, unknown>;
  switch (name) {
    case "settings_update":
      return `Updated ${Object.keys(args).join(", ")}.`;
    case "settings":
      return "Read current settings (see the settings panel for details).";
    case "play_radio":
      return typeof r.station === "string"
        ? `Playing ${r.station} on the radio.`
        : "Radio playback started.";
    case "stop_radio":
      return "Radio stopped.";
    case "radio_list_stations":
      return "Listed the available radio stations.";
    case "radio_now_playing":
      return typeof r.station === "string"
        ? `Checked now-playing for ${r.station}.`
        : "Checked now-playing.";
    case "voice_settings":
      return "Voice settings updated.";
    case "reminder_create":
      return typeof r.dueLocal === "string"
        ? `Reminder set for ${r.dueLocal}.`
        : "Reminder set.";
    case "reminder_list":
      return "Listed reminders.";
    case "reminder_cancel":
      return "Reminder cancelled.";
    case "set_persona":
      return `Persona switched to ${String(args.persona)}.`;
    case "open_preview":
      return `Preview opened at ${String(args.url)}.`;
    // ── Run #5 additions (2026-11-23) ────────────────────────────────
    case "get_time": {
      const date = typeof r.date === "string" ? r.date : null;
      const time = typeof r.time === "string" ? r.time : null;
      if (date && time) return `It's ${time} on ${date} (${String(r.weekday ?? "")}).`;
      return "Checked the current date and time.";
    }
    case "stop_agent":
      return r.stopped === true
        ? "Stopped the current run. Transcript and memory are kept."
        : "Nothing was running in this conversation.";
    case "new_session":
      return "Started a new session. The previous chat is kept in the session list.";
    case "list_skills":
      return typeof r.count === "number"
        ? `You have ${r.count} skill${r.count === 1 ? "" : "s"} saved.`
        : "Listed the available skills.";
    case "list_personas":
      return typeof r.count === "number"
        ? `You have ${r.count} persona${r.count === 1 ? "" : "s"} available.`
        : "Listed the available personas.";
    case "list_sessions":
      return typeof r.count === "number"
        ? `You have ${r.count} session${r.count === 1 ? "" : "s"} in this project.`
        : "Listed the project's sessions.";
    default:
      return `${name} done.`;
  }
}

// ── Synthetic UIMessage stream ────────────────────────────────────────────
// The reflex path bypasses the LLM entirely, so it must return the same
// chunk-stream shape the AI SDK Chat transport contract expects. A minimal
// start -> start-step -> text -> finish sequence renders as one assistant
// message whose text is the execution summary.

type ReflexChunk = InferUIMessageChunk<UIMessage>;

export function reflexAssistantStream(summary: string): ReadableStream<ReflexChunk> {
  const id = "rfx-0";
  const chunks: ReflexChunk[] = [
    { type: "start", messageId: `rfx-${Date.now().toString(36)}` },
    { type: "start-step" },
    { type: "text-start", id },
    { type: "text-delta", id, delta: summary },
    { type: "text-end", id },
    { type: "finish-step" },
    { type: "finish", finishReason: "stop" },
  ];
  let i = 0;
  return new ReadableStream<ReflexChunk>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}
