import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";
import {
  coordinatorGroupForSession,
  sendFromCoordinator,
} from "../store/groupChatStore";
import { getProjectAgentStatus } from "../store/projectStatus";

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
 */

export function buildGroupTools(ctx: ToolContext) {
  const sessionId = ctx.getSessionId();
  const group = sessionId ? coordinatorGroupForSession(sessionId) : null;
  if (!group) return {} as Record<string, never>;

  const participantNames = group.participants
    .filter((p) => p.sessionId !== sessionId)
    .map((p) => `${p.name} (project id: ${p.projectId})`)
    .join("; ");

  return {
    send_to_project: tool({
      description:
        `Send a message to another project's agent in the cross-project group chat (you are the coordinator). FIRE-AND-FORGET: the reply arrives as your NEXT user message — end your turn after calling it, do NOT poll or wait. The participant's agent works only inside its own repo; it cannot read yours. Busy participants receive the message when they go idle. Available projects: ${participantNames}.`,
      inputSchema: z.object({
        project: z
          .string()
          .describe("Target project id (from the list in the tool description)."),
        message: z
          .string()
          .describe("The task or question for that project's agent. Self-contained: include file paths, type names, snippets it needs."),
      }),
      needsApproval: true,
      execute: async ({ project, message }) => {
        const result = await sendFromCoordinator(group.id, project, message);
        return { delivered: !result.startsWith("Delivered"), note: result };
      },
    }),

    project_status: tool({
      description:
        "Check whether another project's agent in the group chat is busy (running/thinking), awaiting your approval request, or idle. Use before send_to_project if you expect an immediate answer.",
      inputSchema: z.object({
        project: z.string().describe("Project id to probe."),
      }),
      needsApproval: false,
      execute: async ({ project }) => {
        const status = getProjectAgentStatus(project);
        const name = group.participants.find((p) => p.projectId === project)?.name ?? project;
        return { project, name, status };
      },
    }),
  };
}
