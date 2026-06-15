import { buildEditTools } from "./edit";
import { buildFsTools } from "./fs";
import { buildImageGenTools } from "./image-gen";
import { buildVideoGenTools } from "./video-gen";
import { buildSearchTools } from "./search";
import { buildShellTools } from "./shell";
import { buildSubagentTools } from "./subagent";
import { buildTerminalTools } from "./terminal";
import { buildTodoTools } from "./todo";
import { buildWebTools } from "./web";
import { buildYouTubeTools } from "./youtube";

export { resolvePath, type ToolContext } from "./context";

/** Core tools: filesystem, editing, shell, terminal — always available. */
export function buildCoreTools(ctx: import("./context").ToolContext) {
  return {
    ...buildFsTools(ctx),
    ...buildEditTools(ctx),
    ...buildShellTools(ctx),
    ...buildTerminalTools(ctx),
  } as const;
}

/** Extended tools: search, subagent, todo, web, media gen — loaded on demand. */
export function buildExtendedTools(ctx: import("./context").ToolContext) {
  return {
    ...buildSearchTools(ctx),
    ...buildSubagentTools(ctx),
    ...buildTodoTools(ctx),
    ...buildWebTools(ctx),
    ...buildYouTubeTools(ctx),
    ...buildImageGenTools(ctx),
    ...buildVideoGenTools(ctx),
  } as const;
}

/** All tools combined (core + extended + MCP). */
export function buildTools(
  ctx: import("./context").ToolContext,
  mcpTools?: Record<string, unknown>,
) {
  return {
    ...buildCoreTools(ctx),
    ...buildExtendedTools(ctx),
    ...(mcpTools ?? {}),
  } as const;
}

export type ChatTools = ReturnType<typeof buildTools>;
export type CoreTools = ReturnType<typeof buildCoreTools>;
export type ExtendedTools = ReturnType<typeof buildExtendedTools>;
