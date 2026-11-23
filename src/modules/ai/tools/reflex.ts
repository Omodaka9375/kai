/**
 * REFLEX-SAFE core tools (2026-11-23, Run #5 needle expansion).
 *
 * These exist so the LOCAL REFLEX fast path (kai-reflex-v1) can answer
 * zero-argument, every-instance KAI commands without a cloud round-trip:
 * time/date, stop the agent, start a fresh session, and the local
 * list-type reads (personas, sessions, skills).
 *
 * Contract (mirrors the settings/radio/reminder tiers):
 *  - ALL needsApproval: false - these are read-only or trivially
 *    reversible session-scoped actions; the reflex executor refuses
 *    anything approval-gated.
 *  - No filesystem, terminal, or project mutation. stop_agent cancels
 *    THIS session's run; new_session leaves the old transcript intact.
 *  - Every-instance: no MCP, no NAS, no network tools - anything that
 *    might not exist on another KAI install stays out (the reason the
 *    domain tools were NOT given to the reflex despite being keyless).
 *  - The optional ctx.projectId / getSessionId indirection means a
 *    BACKGROUND session's reflex run acts on ITS own session, never the
 *    foreground one (same owning-session rule as the approval cards).
 */

import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";
import {
  BUILTIN_AGENTS,
} from "../lib/agents";
import { useAgentsStore } from "../store/agentsStore";
import {
  useChatStore,
  newSessionForProject,
  stopSession,
  getSessionAgentMeta,
} from "../store/chatStore";
import { activeProjectId } from "../store/projectRegistry";

/** Local date formatting used by BOTH the tool result and the reflex
 *  summary line - one timezone source (the runtime locale), so the
 *  reflex's synthetic message can never disagree with the tool output. */
export function localDateTimeString(d: Date = new Date()): {
  date: string;
  time: string;
  weekday: string;
} {
  const fmt = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const timeFmt = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: undefined,
  });
  return {
    date: fmt.format(d),
    time: timeFmt.format(d),
    weekday: new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(d),
  };
}

export function buildReflexTools(ctx: ToolContext) {
  return {
    get_time: tool({
      needsApproval: false,
      description:
        "Get the current local date, time, and weekday. Use for 'what time is it', 'what's the date', 'what day is it'. Answers locally - no web search needed.",
      inputSchema: z.object({}),
      execute: async () => {
        const now = localDateTimeString();
        return {
          date: now.date,
          time: now.time,
          weekday: now.weekday,
          iso: new Date().toISOString(),
        };
      },
    }),

    stop_agent: tool({
      needsApproval: false,
      description:
        "Stop the currently running agent run for THIS conversation: cancels shell sessions, detached media jobs, and the streaming reply. Use when the user says stop, cancel, halt the current run. Stopping is always safe - the transcript and memory are kept. If nothing is running this is a no-op.",
      inputSchema: z.object({}),
      execute: async () => {
        const sessionId = ctx.getSessionId();
        if (!sessionId) return { error: "no active session to stop" };
        // Per-session status (the store-level status follows the FOREGROUND
        // session only - a background card stopping itself must read its own).
        const running = getSessionAgentMeta(sessionId).status !== "idle";
        stopSession(sessionId);
        return {
          ok: true,
          stopped: running,
          note: running
            ? "Run stopped for this conversation. Transcript and memory are kept."
            : "Nothing was running in this conversation.",
        };
      },
    }),

    new_session: tool({
      needsApproval: false,
      description:
        "Start a FRESH chat session for this project (keeps the current transcript - it stays in the session list). Use for 'new chat', 'new session', 'start a fresh conversation'.",
      inputSchema: z.object({}),
      execute: async () => {
        const projectId =
          ctx.projectId ?? activeProjectId() ?? undefined;
        if (!projectId) return { error: "no open project; cannot start a session" };
        const id = newSessionForProject(projectId);
        if (!id) return { error: "project runtime not found" };
        return {
          ok: true,
          sessionId: id,
          note: "New session started. The previous chat is kept in the session list.",
        };
      },
    }),

    list_personas: tool({
      needsApproval: false,
      description:
        "List the available agent personas (built-in and custom): name, description, id. Metadata only. Use for 'what personas do I have', 'list agents'.",
      inputSchema: z.object({}),
      execute: async () => {
        const byId = new Map<string, { id: string; name: string; description: string; builtIn: boolean }>();
        for (const b of BUILTIN_AGENTS)
          byId.set(b.id, { id: b.id, name: b.name, description: b.description, builtIn: true });
        for (const c of useAgentsStore.getState().customAgents)
          byId.set(c.id, { id: c.id, name: c.name, description: c.description, builtIn: false });
        const personas = [...byId.values()];
        return {
          count: personas.length,
          personas,
        };
      },
    }),

    list_sessions: tool({
      needsApproval: false,
      description:
        "List THIS project's chat sessions (title, last-updated, id). Use for 'which chats are open', 'list my sessions'.",
      inputSchema: z.object({}),
      execute: async () => {
        const projectId = ctx.projectId ?? activeProjectId() ?? null;
        const sessions = useChatStore
          .getState()
          .sessions.filter(
            (s) => !projectId || (s as { projectId?: string }).projectId === projectId,
          )
          .slice(0, 20)
          .map((s) => ({
            id: s.id,
            title: s.title,
            updatedAt: s.updatedAt,
          }));
        return {
          count: sessions.length,
          sessions,
        };
      },
    }),
  };
}
