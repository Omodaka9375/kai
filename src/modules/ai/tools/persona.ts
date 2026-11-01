import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";
import { newAgentId, useAgentsStore } from "../store/agentsStore";
import { setSessionPreferences } from "../store/sessionPreferences";
import { useChatStore } from "../store/chatStore";
import { BUILTIN_AGENTS, type Agent, type AgentIconId } from "../lib/agents";

/**
 * PERSONA tools (2026-11-01): the user creates or switches the conversation's
 * agent persona ON DEMAND, in chat — "make me a Test Engineer persona that
 * always runs the tests first", "switch to the Architect persona", "no
 * persona for now". Same capability the AI window's persona picker dropdown
 * has, driven conversationally.
 *
 * CONTEXT/MEMORY SAFETY (the ask: "without losing context or memory"):
 * the persona is a SYSTEM-PROMPT block for subsequent turns — the session's
 * message history, memory, todos, and persisted transcript are untouched.
 * Switching mid-conversation keeps every earlier message; the next turn just
 * runs under the new persona's instructions.
 *
 * BOTH tools are AUTO-RUN (needsApproval: false): a persona write is a
 * trivial, reversible preference (Settings → Agents can edit/delete it),
 * same class as set_my_name — no approval pause.
 *
 * Activation = the picker's own semantics (AgentSwitcher):
 *   1. setSessionPreferences(THIS session, { personaId }) — the per-session
 *      override the picker writes and chatRuntime reads first; applies to
 *      THIS conversation even when the agent runs in a background project.
 *   2. When this session IS the foreground one, also run the full picker
 *      path (useAgentsStore.setActiveId) so the project-level persistence,
 *      the picker's displayed activeId, and cross-window broadcast all match
 *      a manual pick. A BACKGROUND agent never clobbers the foreground
 *      project's persona — its write stays session-scoped.
 */

const ICON_IDS = ["coder", "architect", "reviewer", "security", "designer", "spark"] as const;

/** All personas (custom overrides merged over builtins, picker's ordering). */
function allPersonas(): Agent[] {
  const { customAgents } = useAgentsStore.getState();
  const byId = new Map<string, Agent>();
  for (const b of BUILTIN_AGENTS) byId.set(b.id, b);
  for (const c of customAgents) byId.set(c.id, { ...c, builtIn: byId.has(c.id) });
  return [...byId.values()];
}

/** Activate a persona for THIS conversation (picker semantics, see header). */
function activatePersona(ctx: ToolContext, personaId: string): void {
  const sid = ctx.getSessionId();
  if (!sid) return;
  setSessionPreferences(sid, { personaId });
  // Picker parity ONLY when this conversation is the foreground one: the
  // full setActiveId path persists per-project + broadcasts; in a background
  // session that would reassign ANOTHER project's persona.
  if (useChatStore.getState().activeSessionId === sid) {
    useAgentsStore.getState().setActiveId(personaId);
  }
}

export function buildPersonaTools(ctx: ToolContext) {
  const roster = allPersonas()
    .map((a) => `${a.name} (id: ${a.id})`)
    .join("; ");

  return {
    create_persona: tool({
      description:
        `Create a NEW agent persona and make it active for this conversation. Use when the user describes a role/persona that does not exist yet ("make me a persona that ..."). The persona is saved permanently (editable in Settings → Agents) and applies from the next turn — the conversation's history and memory are NOT lost. Give it focused instructions (what it is, how it should behave). Personas already available: ${roster}.`,
      inputSchema: z.object({
        name: z.string().min(1).max(40).describe("Short persona name (e.g. \"Test Engineer\")."),
        instructions: z
          .string()
          .min(1)
          .describe("The persona's system instructions: what it is, how it behaves, its priorities."),
        description: z
          .string()
          .optional()
          .describe("One line shown in the persona picker (optional)."),
        icon: z
          .enum(ICON_IDS)
          .optional()
          .describe("Picker icon (optional, default: spark)."),
      }),
      needsApproval: false,
      execute: async ({ name, instructions, description, icon }) => {
        const cleanName = name.trim().slice(0, 40);
        if (!cleanName) return { ok: false, error: "empty name" };
        const agent: Agent = {
          id: newAgentId(),
          name: cleanName,
          description: (description ?? "").trim().slice(0, 200),
          instructions,
          icon: (icon ?? "spark") as AgentIconId,
          builtIn: false,
        };
        useAgentsStore.getState().upsert(agent);
        activatePersona(ctx, agent.id);
        return {
          ok: true,
          id: agent.id,
          name: agent.name,
          note: `${agent.name} persona created and now active for this conversation. History and memory are kept — continue in the same chat.`,
        };
      },
    }),

    set_persona: tool({
      description:
        `Switch this conversation's ACTIVE agent persona to an existing one (builtin or custom), by name or id — the same switch the persona picker in the AI window makes. The conversation's history and memory are NOT lost; the next turn just runs under the new persona. Pass "none" to deactivate personas for this conversation. Available: ${roster}.`,
      inputSchema: z.object({
        persona: z
          .string()
          .min(1)
          .describe('The persona to activate: its name or id (from the list), or "none" for no persona.'),
      }),
      needsApproval: false,
      execute: async ({ persona }) => {
        const raw = persona.trim();
        if (raw.toLowerCase() === "none" || raw === "__none__") {
          activatePersona(ctx, "__none__");
          return { ok: true, note: "Persona deactivated for this conversation — you run without a persona block from the next turn." };
        }
        const list = allPersonas();
        const q = raw.toLowerCase().replace(/\s+/g, "");
        const target =
          list.find((a) => a.id === raw) ??
          list.find((a) => a.id === `persona:${raw}`) ??
          list.find((a) => a.name.toLowerCase() === raw.toLowerCase()) ??
          // Relaxed tiers (same classes the group mention matcher uses):
          // space-stripped equality, then PREFIX ("sec" → Security), then
          // substring — so conversational references hit the right persona.
          list.find((a) => a.name.toLowerCase().replace(/\s+/g, "") === q) ??
          list.find((a) => a.name.toLowerCase().replace(/\s+/g, "").startsWith(q)) ??
          list.find((a) => a.name.toLowerCase().includes(raw.toLowerCase()));
        if (!target) {
          return {
            ok: false,
            note: `unknown persona "${raw}" — available: ${list.map((a) => a.name).join(", ")} (or "none")`,
          };
        }
        activatePersona(ctx, target.id);
        return {
          ok: true,
          id: target.id,
          name: target.name,
          note: `${target.name} persona is now active for this conversation (history and memory kept). Use create_persona for a persona that does not exist yet.`,
        };
      },
    }),
  };
}