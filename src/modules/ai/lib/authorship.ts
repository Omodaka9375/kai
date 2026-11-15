/**
 * Authorship tags: which surface CREATED a persistent record.
 *
 * Motivation (2026-11-15 review): the Staff screen was an inventory with no
 * attribution. A persona, skill, or MCP server the agent created was
 * byte-identical to one the user added by hand, so "who gave the agent this
 * standing capability?" had no answer. These tags answer it going forward.
 *
 * Semantics, deliberately narrow:
 *  - The field is OPTIONAL and only ever set to `{ by: "agent" }`, at the
 *    agent-facing choke points (create_persona, create_skill,
 *    mcp_add_server). Records made through the Settings UI carry nothing.
 *  - ABSENCE means "not created through an agent tool" — either you made it
 *    by hand, or it predates this field. Do NOT render absence as "user":
 *    for legacy records that would be a guess, and attribution that guesses
 *    is the fiction this whole feature exists to remove.
 *  - `via` is the persona that was ACTIVE in the foreground when the tool
 *    ran. It is a hint, not a forensic claim: the store keeps one active
 *    persona per window, so a background-session create records whatever the
 *    foreground had selected. The security-relevant half ("agent made this")
 *    is exact; `by` is only set by the tool itself.
 *  - Updates never overwrite creation. An agent EDITING a user's skill keeps
 *    the skill user-authored (the update_skill path re-stamps the original).
 */
import { BUILTIN_AGENTS, NONE_AGENT_ID } from "./agents";
import { useAgentsStore } from "../store/agentsStore";

export type AgentAuthorship = {
  by: "agent";
  /** Display name of the active persona, when one was active. */
  via?: string;
  /** Unix ms of creation. */
  at: number;
};

/** Snapshot for a record created right now by an agent tool call. */
export function agentAuthorship(): AgentAuthorship {
  const { activeId, customAgents } = useAgentsStore.getState();
  const via =
    activeId && activeId !== NONE_AGENT_ID
      ? [...BUILTIN_AGENTS, ...customAgents].find((a) => a.id === activeId)
          ?.name
      : undefined;
  return via ? { by: "agent", via, at: Date.now() } : { by: "agent", at: Date.now() };
}

/** Compact badge label, e.g. "agent · Coder". Only rendered when present. */
export function authorshipLabel(a: AgentAuthorship | undefined): string | null {
  if (!a || a.by !== "agent") return null;
  return a.via ? `agent · ${a.via}` : "agent";
}
