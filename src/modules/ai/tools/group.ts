import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";
import {
  addParticipants,
  addPersonaParticipants,
  coordinatorGroupForSession,
  createGroupChat,
  delegateCoordination,
  getGroup,
  isPersonaParticipantId,
  lastGroupRefusal,
  liveGroupForProject,
  participantActivity,
  sendFromCoordinator,
} from "../store/groupChatStore";
import { getProjectAgentStatus } from "../store/projectStatus";
import { useAgentsStore } from "../store/agentsStore";
import { BUILTIN_AGENTS } from "../lib/agents";

/** Display name for a project runtime: the root's basename (the panel and
 *  rail derive their project names the same way). */
function runtimeName(root: string): string {
  const parts = root.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? root;
}

/**
 * Phase 2 group-chat tools — attached ONLY when this session is the
 * user-delegated AGENT COORDINATOR of a live group. buildGroupTools returns
 * {} for every other session, so the tools never ride a normal turn.
 *
 * send_to_project is FIRE-AND-FORGET by design: it queues the message for
 * the participant (busy agents flush on idle) and returns immediately. The
 * participant's reply is relayed back as the coordinator's NEXT user
 * message by AgentRunBridge — the same yield-and-resume pattern as watch
 * wake-ups. No polling, no held tool executions.
 *
 * invite_agent (2026-11-01): the AGENT-driven invite. When the user asks
 * the coordinator to "invite X into this group", the tool joins a project
 * agent or a persona into the live group — the same store path the panel's
 * human invite uses (addParticipants/addPersonaParticipants) — and then
 * OPENS the group panel on the user's screen via the same window event the
 * status-bar button uses, so the user sees the group exactly as if they had
 * opened it themselves (their ask: "it needs to be visible in UI when agent
 * opens group chat so user can see the group like he opened it").
 * APPROVAL-GATED: joining an agent into a group is a membership grant — a
 * bigger deal than a message send — so the user clicks Allow first, every
 * time (never auto-approved).
 */

export function buildGroupTools(ctx: ToolContext) {
  const sessionId = ctx.getSessionId();
  const group = sessionId ? coordinatorGroupForSession(sessionId) : null;
  if (!group) return {} as Record<string, never>;

  const participantNames = group.participants
    .filter((p) => p.sessionId !== sessionId)
    .map((p) =>
      isPersonaParticipantId(p.projectId)
        ? `${p.name} (persona id: ${p.projectId} — no project/workspace; it replies from its own expertise)`
        : `${p.name} (project id: ${p.projectId})`)
    .join("; ");

  // INVITABLE roster for the tool description: projects open in the app
  // (registered runtimes) + agent personas, minus existing members.
  const memberIds = new Set(group.participants.map((p) => p.projectId));
  // Open projects come from the ToolContext provider (chatRuntime injects
  // the store accessor; tests inject doubles) — the tool never reaches into
  // chatStore's module-private registry itself.
  const allRuntimes = ctx.getAllProjectRuntimes?.() ?? [];
  const invitableProjects = allRuntimes
    .filter((r) => !memberIds.has(r.id))
    // SINGLE MEMBERSHIP (audit M3, Option A): a project already live in
    // ANOTHER group cannot join this one either — leaving it in the roster
    // invites an approval card that can only end in a refusal note.
    .filter((r) => !liveGroupForProject(r.id))
    .map((r) => `${runtimeName(r.root)} (project id: ${r.id})`);
  const invitablePersonas = [
    ...useAgentsStore.getState().customAgents,
    ...BUILTIN_AGENTS,
  ]
    .map((a) => ({ id: a.id, name: a.name }))
    .filter((a) => !memberIds.has(`persona:${a.id}`))
    .map((a) => `${a.name} (persona id: ${a.id})`);
  const invitableList = [...invitableProjects, ...invitablePersonas].join("; ");

  return {
    invite_agent: tool({
      description:
        `Invite another agent into this cross-project group chat (you are the coordinator). Pass a project id to invite that project's agent, or a persona id to invite an agent persona (replies from its own expertise, no project). The user is asked to approve before anyone joins. After the invite the group panel opens on the user's screen so they see the group. Invitable now: ${invitableList || "(nobody — all open projects and personas are already members)"}.`,
      inputSchema: z.object({
        agent: z
          .string()
          .describe("Who to invite: a project id or a persona id (from the list in the tool description)."),
        announce: z
          .string()
          .optional()
          .describe("Optional one-line note appended to the group transcript (why they were invited)."),
      }),
      needsApproval: true,
      execute: async ({ agent, announce }) => {
        const live = getGroup(group.id);
        if (!live || live.endedAt !== null)
          return { ok: false, note: "the group has ended — nobody can join" };
        // Resolve what the id names: an open project (fresh roster read at
        // execute time — projects may have opened since build), a registered
        // persona, or a persona already in synthetic form ("persona:<id>").
        const project = (ctx.getAllProjectRuntimes?.() ?? []).find(
          (r) => r.id === agent,
        );
        const { customAgents } = useAgentsStore.getState();
        const personaId = agent.startsWith("persona:")
          ? agent.slice("persona:".length)
          : agent;
        const persona =
          customAgents.find((x) => x.id === personaId) ??
          BUILTIN_AGENTS.find((x) => x.id === personaId);
        if (!project && !persona)
          return {
            ok: false,
            note: `unknown agent "${agent}" — invitable: ${invitableList || "(nobody)"}`,
          };
        if (project) {
          await addParticipants(group.id, [
            { projectId: project.id, root: project.root, name: runtimeName(project.root) },
          ]);
        } else if (persona) {
          await addPersonaParticipants(group.id, [persona.id]);
        }
        if (announce?.trim()) {
          const { appendGroupMessage } = await import("../store/groupChatStore");
          // AGENT-AUTHORED, AGENT-LABELED (2026-11-02 audit NIT): the
          // announce note is the COORDINATOR's own words, not machinery
          // output. "system" mislabeled model text; attribute the author
          // so the transcript (and any future consumer) sees who spoke.
          const coord = live.coordinator;
          await appendGroupMessage(group.id, {
            from: "agent",
            projectId: coord.kind === "agent" ? coord.projectId : "",
            sessionId: coord.kind === "agent" ? coord.sessionId : "",
            text: announce.trim().slice(0, 200),
          });
        }
        // OPEN THE GROUP PANEL for the user — the same event the rail/status
        // bar dispatches. The agent "opening" the group must be as visible
        // as the user opening it themselves (their ask, 2026-11-01).
        window.dispatchEvent(
          new CustomEvent("Kai:open-group-chat", { detail: group.id }),
        );
        return {
          ok: true,
          note: `${project ? runtimeName(project.root) : persona?.name} was invited into the group and the group panel is now open for the user. Greet the new member by @-mentioning them.`,
        };
      },
    }),

    send_to_project: tool({
      description:
        `Send a message to another participant in the cross-project group chat (you are the coordinator). FIRE-AND-FORGET: the reply arrives as your NEXT user message — end your turn after calling it, do NOT poll or wait. Project participants work only inside their own repo; persona participants have no project and reply from their own expertise. Busy participants receive the message when they go idle. Available participants: ${participantNames}.`,
      inputSchema: z.object({
        project: z
          .string()
          .describe("Target participant id (from the list in the tool description)."),
        message: z
          .string()
          .describe("The task or question for that project's agent. Self-contained: include file paths, type names, snippets it needs."),
      }),
      needsApproval: true,
      execute: async ({ project, message }) => {
        const result = await sendFromCoordinator(group.id, project, message);
        return { delivered: result.startsWith("Delivered"), note: result };
      },
    }),

    project_status: tool({
      description:
        "Check whether another participant in the group chat is busy (running/thinking), awaiting your approval request, or idle. Project participants and persona participants are both probed. Use before send_to_project if you expect an immediate answer.",
      inputSchema: z.object({
        project: z.string().describe("Participant id to probe."),
      }),
      needsApproval: false,
      execute: async ({ project }) => {
        const target = group.participants.find((p) => p.projectId === project);
        const status = isPersonaParticipantId(project)
          ? // groupId-scoped (2026-11-02 audit NIT): a persona in two groups
            // reports THIS group's state, not the any-group bleed.
            participantActivity(target?.sessionId ?? project, group.id)
          : getProjectAgentStatus(project);
        const name = target?.name ?? project;
        return { project, name, status };
      },
    }),
  };
}

/**
 * create_group (2026-11-18): the agent-driven CREATE path. Until now group
 * creation was human-only (panel InvitePicker) — an agent asked to "create
 * a group with X" could only decline ("group chat is a UI thing"), because
 * the coordinator tools below attach ONLY to a delegated coordinator of an
 * EXISTING group. This tool closes the bootstrap gap.
 *
 * TRUST BOUNDARY — membership stays HUMAN-GRANTED, the approval card IS the
 * grant: needsApproval is always-on (never auto-approved, same class as
 * invite_agent; the STANDING_AUTHORITY carve-outs do not apply either). The
 * card shows exactly which projects/personas will join, and the user clicks
 * Allow before anything is created. After creation the group panel opens on
 * the user's screen (same event invite_agent uses) so it is as visible as if
 * they had opened it themselves.
 *
 * The INVITER is this session's project; the creating agent's session is the
 * inviter's active session (the same record shape the panel writes).
 *
 * COORDINATOR DEFAULTS (2026-11-18 product decision): an AGENT-created group
 * defaults the creating agent to coordinator (delegate_to_self, default
 * true) — the user asked THAT agent to run the group, and the approval
 * card IS the human grant of both membership and coordination. A
 * USER-created group (panel) keeps the USER as coordinator, unchanged.
 * delegate_to_self: false leaves the user as coordinator for the rare case
 * the agent should not run it.
 *
 * PHASE-2 PIN, NARROWED (not dropped): delegation from tool code is allowed
 * ONLY here, inside create_group's approval-gated execute — buildGroupTools
 * still never delegates (the phase2 pin test asserts the call appears only
 * after this function's marker).
 *
 * Available to EVERY session (not gated on coordinator status — that is the
 * point), but returns an honest error when this tool context carries no
 * project (assistant/headless contexts) or the project is busy elsewhere.
 */
export function buildCreateGroupTool(ctx: ToolContext) {
  return {
    create_group: tool({
      description:
        `Create a cross-project group chat between THIS project's agent and other open projects' agents and/or agent personas. Use when the user asks you to set up a group chat, coordinate several projects together, or bring agents into one conversation. Every member joining requires the user's approval on a card first; after creation the group panel opens on the user's screen and YOU become the group's coordinator by default (use send_to_project to message members and invite_agent to add more). Pass delegate_to_self: false to leave the user as coordinator. Invitable now: ` +
        (() => {
          const runtimes = ctx.getAllProjectRuntimes?.() ?? [];
          const own = ctx.projectId;
          const memberable = runtimes.filter(
            (r) => r.id !== own && !liveGroupForProject(r.id),
          );
          const projects = memberable
            .map((r) => `${runtimeName(r.root)} (project id: ${r.id})`);
          const personas = [
            ...useAgentsStore.getState().customAgents,
            ...BUILTIN_AGENTS,
          ].map((a) => `${a.name} (persona id: ${a.id})`);
          const list = [...projects, ...personas].join("; ");
          return list || "(nobody — open more projects or use personas)";
        })() +
        `. Your own project joins automatically as the inviter; do not include it in members.`,
      inputSchema: z.object({
        members: z
          .array(z.string())
          .min(1)
          .describe(
            "Who to bring into the group: project ids and/or persona ids (from the list in the tool description).",
          ),
        group_name: z
          .string()
          .optional()
          .describe(
            "Optional short group name. Defaults to a themed auto-name.",
          ),
        delegate_to_self: z
          .boolean()
          .optional()
          .describe(
            "Make YOU the group coordinator after creation (default true). Pass false only when the user should coordinate it themselves.",
          ),
      }),
      needsApproval: true,
      execute: async ({ members, group_name, delegate_to_self }) => {
        const sessionId = ctx.getSessionId();
        const ownProjectId = ctx.projectId;
        if (!sessionId)
          return { ok: false, note: "no active chat session" };
        if (!ownProjectId)
          return {
            ok: false,
            note: "this session has no project — groups are created between projects",
          };
        const runtimes = ctx.getAllProjectRuntimes?.() ?? [];
        const own = runtimes.find((r) => r.id === ownProjectId);
        if (!own)
          return {
            ok: false,
            note: "this project has no open runtime",
          };
        // Already live elsewhere? SINGLE MEMBERSHIP applies to the inviter
        // too — surface the store refusal instead of a silent null.
        if (liveGroupForProject(ownProjectId)) {
          return {
            ok: false,
            note: `this project is already in the live group "${liveGroupForProject(ownProjectId)!.name}" — end it first`,
          };
        }

        // Resolve members: open projects and personas, split by kind.
        const projectMembers: Array<{ projectId: string; root: string; name: string }> = [];
        const personaMembers: string[] = [];
        const unknown: string[] = [];
        const { customAgents } = useAgentsStore.getState();
        for (const m of members) {
          const project = runtimes.find((r) => r.id === m && r.id !== ownProjectId);
          if (project) {
            projectMembers.push({
              projectId: project.id,
              root: project.root,
              name: runtimeName(project.root),
            });
            continue;
          }
          const personaId = m.startsWith("persona:") ? m.slice("persona:".length) : m;
          const persona =
            customAgents.find((x) => x.id === personaId) ??
            BUILTIN_AGENTS.find((x) => x.id === personaId);
          if (persona) {
            personaMembers.push(persona.id);
            continue;
          }
          unknown.push(m);
        }
        if (unknown.length === members.length)
          return {
            ok: false,
            note: `no invitable members matched: ${unknown.join(", ")}`,
          };

        // Same shapes the panel writes: inviter with THIS session, project
        // invitees as records; personas joined AFTER creation (same two-step
        // the panel performs — createGroupChat takes project invitees only).
        const g = await createGroupChat(
          {
            projectId: ownProjectId,
            sessionId,
            root: own.root,
            name: runtimeName(own.root),
          },
          projectMembers,
          group_name,
        );
        if (!g) {
          return {
            ok: false,
            note: lastGroupRefusal() ?? "group creation was refused",
          };
        }
        if (personaMembers.length > 0) {
          await addPersonaParticipants(g.id, personaMembers);
        }
        // AGENT-CREATED DEFAULT (2026-11-18): the creating agent becomes the
        // group's coordinator — the approval card granted it. The ONLY
        // tool-code call site of delegateCoordination (see the narrowed
        // phase-2 pin in this file's header + phase2 test).
        const selfCoordinate = delegate_to_self !== false;
        if (selfCoordinate) {
          await delegateCoordination(g.id, ownProjectId);
        }
        // OPEN THE GROUP PANEL — same event invite_agent dispatches, so the
        // agent-created group is exactly as visible as a user-created one.
        window.dispatchEvent(
          new CustomEvent("Kai:open-group-chat", { detail: g.id }),
        );
        const live = getGroup(g.id);
        return {
          ok: true,
          group_id: g.id,
          group_name: live?.name ?? g.name,
          note:
            `Group created with ${live?.participants.length ?? 0} participants and the panel is now open for the user. ` +
            (selfCoordinate
              ? "You are the coordinator: use send_to_project to message members and invite_agent to add more."
              : "The user coordinates the group.") +
            (unknown.length
              ? ` Skipped unknown members: ${unknown.join(", ")}.`
              : ""),
        };
      },
    }),
  };
}
