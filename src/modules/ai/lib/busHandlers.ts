/**
 * Bus event handlers for agent lifecycle side effects.
 * Import this module once at app init to register handlers.
 */

import { agentBus } from "./eventBus";
import { closeShellSession } from "../tools/shell";
import { resetEditFailures } from "../tools/edit";

/** Register all bus event handlers. Call once at app startup. */
export function initBusHandlers(): void {
  agentBus.on("session:delete", ({ sessionId }) => {
    closeShellSession(sessionId);
    resetEditFailures();
  });
}
