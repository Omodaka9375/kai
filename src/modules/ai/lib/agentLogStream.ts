/**
 * Agent Log Streaming Service
 * Polls for logs from background processes and updates agent state in real-time
 */

import { native } from "../lib/native";
import { useAgentOrchestratorStore } from "../store/agentOrchestratorStore";

const POLL_INTERVAL_MS = 2000; // Poll every 2 seconds
const MAX_LOG_ENTRIES = 100; // Keep last 100 log entries per agent

type LogState = {
  handle: number;
  offset: number;
  lastUpdate: number;
};

const activeLogStates = new Map<number, LogState>();
let pollInterval: NodeJS.Timeout | null = null;

/**
 * Start log streaming for an agent
 */
export function startAgentLogStreaming(handle: number): void {
  if (!activeLogStates.has(handle)) {
    activeLogStates.set(handle, {
      handle,
      offset: 0,
      lastUpdate: Date.now(),
    });
  }

  // Start polling if not already running
  if (!pollInterval) {
    startPolling();
  }
}

/**
 * Stop log streaming for an agent
 */
export function stopAgentLogStreaming(handle: number): void {
  activeLogStates.delete(handle);

  // Stop polling if no more agents
  if (activeLogStates.size === 0 && pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

/**
 * Start the polling loop
 */
function startPolling(): void {
  pollInterval = setInterval(async () => {
    await pollAllAgents();
  }, POLL_INTERVAL_MS);
}

/**
 * Poll logs for all active agents
 */
async function pollAllAgents(): Promise<void> {
  for (const [handle, state] of activeLogStates.entries()) {
    try {
      const result = await native.shellBgLogs(handle, state.offset);

      if (result.bytes) {
        // Parse the new logs
        const newLogs = parseLogs(result.bytes);
        
        if (newLogs.length > 0) {
          // Find the agent with this handle and update its logs
          const agents = useAgentOrchestratorStore.getState().agents;
          const agent = agents.find((a) => a.pid === handle);
          
          if (agent) {
            const updatedLogs = mergeLogs(agent.logs, newLogs);
            useAgentOrchestratorStore.getState().updateAgentLogs(agent.id, updatedLogs);
          }
        }
      }

      // Update offset for next poll
      activeLogStates.set(handle, {
        ...state,
        offset: result.next_offset,
        lastUpdate: Date.now(),
      });

      // Stop streaming if process exited
      if (result.exited) {
        stopAgentLogStreaming(handle);
      }
    } catch (error) {
      console.warn(`[AgentLogStream] Error polling logs for handle ${handle}:`, error);
    }
  }
}

/**
 * Parse raw log bytes into individual log entries
 */
function parseLogs(raw: string): string[] {
  // Split by newlines and filter empty lines
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      // Add timestamp if not present
      if (!line.startsWith("[")) {
        return `[${new Date().toISOString()}] ${line}`;
      }
      return line;
    });
}

/**
 * Merge new logs with existing logs, keeping only the last MAX_LOG_ENTRIES
 */
function mergeLogs(existing: string[], newLogs: string[]): string[] {
  const merged = [...existing, ...newLogs];
  
  // Keep only the last MAX_LOG_ENTRIES
  if (merged.length > MAX_LOG_ENTRIES) {
    return merged.slice(merged.length - MAX_LOG_ENTRIES);
  }
  
  return merged;
}

/**
 * Get current log state for a handle
 */
export function getLogState(handle: number): LogState | undefined {
  return activeLogStates.get(handle);
}

/**
 * Get all active log states
 */
export function getAllLogStates(): Map<number, LogState> {
  return new Map(activeLogStates);
}

/**
 * Cleanup: stop all polling
 */
export function stopAllLogStreaming(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  activeLogStates.clear();
}
