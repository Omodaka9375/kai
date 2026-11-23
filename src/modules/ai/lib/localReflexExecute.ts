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
};

export type ReflexExecResult = {
  ok: boolean;
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

export async function executeReflexCalls(
  calls: CanonicalCall[],
  ctx: ToolContext,
): Promise<ReflexExecResult> {
  const lines: string[] = [];
  let tools: Record<string, ExecutableTool> | null = null;

  for (const call of calls) {
    if (!REFLEX_ALLOWED_CANONICAL_TOOLS.has(call.name)) {
      return { ok: false, lines };
    }
    if (!tools) tools = buildCoreTools(ctx) as unknown as Record<string, ExecutableTool>;
    const tool = tools[call.name];
    if (!tool || typeof tool.execute !== "function") {
      return { ok: false, lines };
    }
    if (isApprovalRequired(tool, call.arguments)) {
      return { ok: false, lines };
    }
    try {
      const result = await tool.execute(call.arguments, {});
      lines.push(describeCall(call.name, call.arguments, result));
    } catch (e) {
      lines.push(`${call.name}: failed (${String(e).slice(0, 120)})`);
      return { ok: false, lines };
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
