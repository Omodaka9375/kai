import type { AgentRunStatus } from "./chatStore";

const statuses = new Map<string, AgentRunStatus>();
/** Projects with UNSEEN agent-side news (a watch fired there while another
 *  project was active). Cleared when the user switches to the project. */
const newsFlags = new Map<string, boolean>();
const listeners = new Set<() => void>();

export function setProjectAgentStatus(projectId: string, status: AgentRunStatus): void {
  if (statuses.get(projectId) === status) return;
  statuses.set(projectId, status);
  for (const listener of listeners) listener();
}

export function getProjectAgentStatus(projectId: string): AgentRunStatus {
  return statuses.get(projectId) ?? "idle";
}

export function subscribeProjectAgentStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Mark that a project has agent-side news the user hasn't seen yet
 *  (watch fired, agent replied) - set when the event lands in a project
 *  other than the active one, so the rail can demand attention. */
export function setProjectHasNews(projectId: string, has: boolean): void {
  if ((newsFlags.get(projectId) ?? false) === has) return;
  if (has) newsFlags.set(projectId, true);
  else newsFlags.delete(projectId);
  for (const listener of listeners) listener();
}

export function getProjectHasNews(projectId: string): boolean {
  return newsFlags.get(projectId) ?? false;
}
