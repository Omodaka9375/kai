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
import { buildMemoryTools } from "./memory";
import { buildBatchEditTools } from "./batchEdit";
import { buildTerminalImageTools } from "./terminalImage";
import { buildTerminalVideoTools } from "./terminalVideo";
import { buildWatchTools } from "./watch";
import { buildScreenTools } from "./screen";
import { buildMcpTools } from "./mcpTools";
import { buildRadioTools } from "./radio";
import { buildVoiceTools } from "./voice";

export { resolvePath, type ToolContext } from "./context";

/** Core tools: filesystem, editing, shell, terminal — always available. */
export function buildCoreTools(ctx: import("./context").ToolContext) {
  return {
    ...buildFsTools(ctx),
    ...buildEditTools(ctx),
    ...buildShellTools(ctx),
    ...buildTerminalTools(ctx),
    ...buildMemoryTools(ctx),
    ...buildBatchEditTools(ctx),
    ...buildTerminalImageTools(ctx),
    ...buildTerminalVideoTools(ctx),
    ...buildWatchTools(ctx),
    ...buildScreenTools(ctx),
    ...buildMcpTools(ctx),
    ...buildRadioTools(ctx),
    ...buildVoiceTools(ctx),
  } as const;
}

/** Extended tools: search, subagent, todo, web, media gen — loaded on demand. */
export function buildExtendedTools(ctx: import("./context").ToolContext) {
  return {
    ...buildSearchTools(ctx),
    ...buildSubagentTools(ctx),
    ...buildTodoTools(ctx),
    ...buildWebTools(ctx),
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