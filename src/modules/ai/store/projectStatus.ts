import type { AgentRunStatus } from "./chatStore";

const statuses = new Map<string, AgentRunStatus>();
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
