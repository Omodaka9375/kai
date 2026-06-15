/**
 * AI Extension System — Phase 1: Lifecycle Hooks.
 * Provides a registry for extensions that hook into agent lifecycle events.
 */

/** Context passed to most extension hooks. */
export type ExtensionHookContext = {
  sessionId: string;
  modelId: string;
};

/** Extension hook definitions. */
export type AgentExtension = {
  /** Unique identifier. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Whether the extension is currently enabled. */
  enabled: boolean;
  /** Called when an agent run starts. */
  onAgentStart?: (ctx: ExtensionHookContext) => void | Promise<void>;
  /** Called when an agent run ends. */
  onAgentEnd?: (
    ctx: ExtensionHookContext & { stepCount: number; finishReason: string },
  ) => void | Promise<void>;
  /** Called when a tool is invoked. */
  onToolCall?: (
    ctx: ExtensionHookContext & { toolName: string; toolCallId: string },
  ) => void | Promise<void>;
  /** Called when a tool returns a result. */
  onToolResult?: (
    ctx: ExtensionHookContext & { toolName: string; ok: boolean },
  ) => void | Promise<void>;
  /** Called when the active session changes. */
  onSessionSwitch?: (ctx: {
    fromId: string | null;
    toId: string;
  }) => void | Promise<void>;
};

/** Registry for managing agent extensions. */
class ExtensionRegistry {
  private extensions = new Map<string, AgentExtension>();

  register(ext: AgentExtension): void {
    this.extensions.set(ext.id, ext);
  }

  unregister(id: string): void {
    this.extensions.delete(id);
  }

  get(id: string): AgentExtension | undefined {
    return this.extensions.get(id);
  }

  getAll(): AgentExtension[] {
    return [...this.extensions.values()].filter((e) => e.enabled);
  }

  getAllIncludingDisabled(): AgentExtension[] {
    return [...this.extensions.values()];
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const ext = this.extensions.get(id);
    if (ext) {
      ext.enabled = enabled;
      return true;
    }
    return false;
  }

  /** Fire a hook on all enabled extensions. Errors are caught, not propagated. */
  async fire<K extends keyof AgentExtension>(
    hook: K,
    ...args: AgentExtension[K] extends (...a: infer A) => unknown ? A : never
  ): Promise<void> {
    for (const ext of this.getAll()) {
      const fn = ext[hook];
      if (typeof fn === "function") {
        try {
          await (fn as (...a: unknown[]) => unknown)(...args);
        } catch (e) {
          console.warn(
            `[Kai] Extension "${ext.id}" hook "${String(hook)}" failed:`,
            e,
          );
        }
      }
    }
  }
}

/** Singleton extension registry. */
export const extensionRegistry = new ExtensionRegistry();

// ── Built-in extensions ─────────────────────────────────────────────────

/** Cost logger — logs agent run start/end to console. */
export const costLoggerExtension: AgentExtension = {
  id: "kai:cost-logger",
  name: "Cost Logger",
  enabled: true,
  onAgentStart: async (ctx) => {
    console.info(
      `[Kai] Agent run started: session=${ctx.sessionId} model=${ctx.modelId}`,
    );
  },
  onAgentEnd: async (ctx) => {
    console.info(
      `[Kai] Agent run ended: session=${ctx.sessionId} steps=${ctx.stepCount} reason=${ctx.finishReason}`,
    );
  },
};

extensionRegistry.register(costLoggerExtension);
