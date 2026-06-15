/**
 * Typed event bus for agent lifecycle events.
 * Decouples agent operations from React rendering.
 */

import type { AgentRunStatus } from "@/modules/ai/store/chatStore";

/** Event payload definitions for all agent lifecycle events. */
export type AgentEventMap = {
  "agent:start": { sessionId: string };
  "agent:end": {
    sessionId: string;
    stepCount: number;
    finishReason: string;
  };
  "agent:error": { sessionId: string; error: string };
  "turn:start": { sessionId: string; turnIndex: number };
  "turn:end": { sessionId: string; turnIndex: number };
  "tool:call": {
    sessionId: string;
    toolName: string;
    toolCallId: string;
  };
  "tool:result": {
    sessionId: string;
    toolName: string;
    toolCallId: string;
    ok: boolean;
  };
  "tool:approval": {
    sessionId: string;
    toolName: string;
    approvalId: string;
  };
  "status:change": { sessionId: string; status: AgentRunStatus };
  "usage:update": {
    sessionId: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  };
  "session:switch": { fromId: string | null; toId: string };
  "session:delete": { sessionId: string };
  "model:change": { modelId: string };
};

type EventHandler<T> = (data: T) => void;

class AgentEventBus {
  private listeners = new Map<
    keyof AgentEventMap,
    Set<EventHandler<unknown>>
  >();

  /** Subscribe to an event. Returns unsubscribe function. */
  on<K extends keyof AgentEventMap>(
    event: K,
    handler: EventHandler<AgentEventMap[K]>,
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    const handlers = this.listeners.get(event)!;
    handlers.add(handler as EventHandler<unknown>);
    return () => this.off(event, handler);
  }

  /** Unsubscribe from an event. */
  off<K extends keyof AgentEventMap>(
    event: K,
    handler: EventHandler<AgentEventMap[K]>,
  ): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.delete(handler as EventHandler<unknown>);
    }
  }

  /** Emit an event to all subscribers. */
  emit<K extends keyof AgentEventMap>(
    event: K,
    data: AgentEventMap[K],
  ): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (err) {
          console.error(`[agentBus] Error in handler for "${event}":`, err);
        }
      }
    }
  }

  /** Remove all listeners. */
  clear(): void {
    this.listeners.clear();
  }
}

/** Singleton event bus instance. */
export const agentBus = new AgentEventBus();
