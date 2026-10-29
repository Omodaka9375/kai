/**
 * Tool presentation + policy metadata registry — ONE source of truth for
 * per-tool display and behavior facts that used to live in four
 * independently-maintained string-keyed tables:
 *
 *  - agent.ts         TOOL_LABELS   (live step status text)
 *  - tool.tsx         TOOL_META     (card header label)
 *  - tool.tsx         deriveSummary (header one-liner from args)
 *  - toolFencing.ts   DEFAULT_EFFECT / NO_FENCE / REMOTE_SURFACE_TOOLS
 *
 * dsh's lesson (P4): a tool's presentation is part of its contract. Here it
 * is at least in ONE contract — adding a tool means filling one row, not
 * hunting five files. All functions are pure and synchronous: they must
 * render identically from a persisted transcript replay (args + output are
 * the only inputs, ever).
 *
 * Unknown tools (MCP, future additions) resolve through the defaults in
 * `presentationFor` — fence everything, treat `server__name` as remote,
 * NONE effect, generic label. A missing row is safe, never a crash.
 */

import type { EffectStatus } from "./effectStatus";

export type ToolPresentation = {
  /** Card header label (tool.tsx). undefined → `prettyToolName` fallback. */
  label?: string;
  /** Card title in AiToolApproval (fuller phrasing than the compact header
   *  label). undefined → raw tool name (existing fallback). */
  approvalLabel?: string;
  /** Live status-bar text, built from the call args (agent.ts onStepFinish).
   *  undefined → `Calling <name>` fallback. */
  status?: (args: Record<string, unknown>) => string;
  /** One-line arg summary under the card header. undefined → no summary. */
  summary?: (args: Record<string, unknown>) => string | null;
  /** Default effect status before result inspection (toolFencing). */
  effect: EffectStatus;
  /** False = result is NOT fenced (structural/no-text-output tools). */
  fence: boolean;
  /** True = output comes from a surface KAI does not control → flips the
   *  session's injection-exposure provenance. MCP (`__`) is implied. */
  remoteSurface: boolean;
};

function shortPath(p: unknown): string {
  if (typeof p !== "string") return "";
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i === -1 ? p : p.slice(i + 1);
}

function ellipsize(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Shared string field reader for summaries. */
const str = (i: Record<string, unknown>, k: string): string | null =>
  typeof i[k] === "string" ? (i[k] as string) : null;

const REGISTRY: Record<string, ToolPresentation> = {
  // ── Filesystem ────────────────────────────────────────────────────────
  read_file: {
    label: "Read",
    status: (a) => `Reading ${shortPath(a.path)}`,
    summary: (a) => str(a, "path"),
    effect: "NONE",
    fence: true,
    remoteSurface: false,
  },
  list_directory: {
    label: "List",
    status: (a) => `Listing ${shortPath(a.path)}`,
    summary: (a) => str(a, "path"),
    effect: "NONE",
    fence: true,
    remoteSurface: false,
  },
  write_file: {
    label: "Write",
    approvalLabel: "Write file",
    status: (a) => `Writing ${shortPath(a.path)}`,
    summary: (a) => str(a, "path"),
    effect: "COMMITTED",
    fence: true,
    remoteSurface: false,
  },
  edit: {
    label: "Edit",
    approvalLabel: "Edit file",
    status: (a) => `Editing ${shortPath(a.path)}`,
    summary: (a) => str(a, "path"),
    effect: "COMMITTED",
    fence: true,
    remoteSurface: false,
  },
  multi_edit: {
    label: "Edit",
    approvalLabel: "Edit file (batch)",
    status: (a) => `Editing ${shortPath(a.path)}`,
    summary: (a) => str(a, "path"),
    effect: "COMMITTED",
    fence: true,
    remoteSurface: false,
  },
  batch_edit: {
    status: (a) =>
      `Batch editing ${Array.isArray(a.edits) ? a.edits.length : 0} files`,
    summary: (a) =>
      Array.isArray(a.edits)
        ? `${a.edits.length} file${a.edits.length === 1 ? "" : "s"}`
        : null,
    effect: "COMMITTED",
    fence: true,
    remoteSurface: false,
  },
  create_directory: {
    label: "Create dir",
    approvalLabel: "Create directory",
    status: (a) => `Creating ${shortPath(a.path)}`,
    summary: (a) => str(a, "path"),
    effect: "COMMITTED",
    fence: true,
    remoteSurface: false,
  },
  fs_delete: { effect: "COMMITTED", fence: true, remoteSurface: false },
  fs_rename: { effect: "COMMITTED", fence: true, remoteSurface: false },
  fs_create_file: { effect: "COMMITTED", fence: true, remoteSurface: false },

  // ── Search ────────────────────────────────────────────────────────────
  grep: {
    label: "Search",
    status: (a) => `Grepping ${ellipsize(String(a.pattern ?? ""), 40)}`,
    summary: (a) => str(a, "pattern") ?? str(a, "query"),
    effect: "NONE",
    fence: true,
    remoteSurface: false,
  },
  glob: {
    label: "Glob",
    status: (a) => `Globbing ${ellipsize(String(a.pattern ?? ""), 40)}`,
    summary: (a) => str(a, "pattern"),
    effect: "NONE",
    fence: true,
    remoteSurface: false,
  },
  fs_search: { effect: "NONE", fence: true, remoteSurface: false },
  fs_grep: { effect: "NONE", fence: true, remoteSurface: false },

  // ── Shell / processes ─────────────────────────────────────────────────
  bash_run: {
    label: "Run",
    approvalLabel: "Run shell command",
    status: (a) => `Running ${ellipsize(String(a.command ?? ""), 60)}`,
    summary: (a) => str(a, "command"),
    effect: "COMMITTED",
    fence: true,
    remoteSurface: false,
  },
  bash_background: {
    label: "Spawn",
    approvalLabel: "Spawn background process",
    status: (a) => `Spawning ${ellipsize(String(a.command ?? ""), 60)}`,
    summary: (a) => str(a, "command"),
    effect: "UNKNOWN",
    fence: false, // structural (handle only)
    remoteSurface: false,
  },
  bash_logs: {
    label: "Logs",
    status: () => `Reading logs`,
    summary: (a) => str(a, "id") ?? (a.handle !== undefined ? String(a.handle) : null),
    effect: "NONE",
    fence: true,
    remoteSurface: false,
  },
  bash_list: {
    label: "Jobs",
    status: () => `Listing background processes`,
    effect: "NONE",
    fence: false,
    remoteSurface: false,
  },
  bash_kill: {
    label: "Kill",
    status: () => `Stopping background process`,
    summary: (a) => str(a, "id") ?? (a.handle !== undefined ? String(a.handle) : null),
    effect: "UNKNOWN",
    fence: false,
    remoteSurface: false,
  },
  shell_session_run: { effect: "COMMITTED", fence: true, remoteSurface: false },
  get_terminal_output: { effect: "NONE", fence: true, remoteSurface: false },

  // ── Web ───────────────────────────────────────────────────────────────
  web_browse: { effect: "NONE", fence: true, remoteSurface: true },
  web_fetch: { effect: "NONE", fence: true, remoteSurface: true },
  web_search: { effect: "NONE", fence: true, remoteSurface: true },

  // ── Structure / delegation ────────────────────────────────────────────
  todo_write: {
    label: "Todos",
    status: (a) =>
      `Updating plan (${Array.isArray(a.todos) ? a.todos.length : 0} items)`,
    summary: (a) => {
      const items = Array.isArray(a.todos) ? a.todos : null;
      return items
        ? `${items.length} item${items.length === 1 ? "" : "s"}`
        : null;
    },
    effect: "COMMITTED",
    fence: false,
    remoteSurface: false,
  },
  checkpoint_undo: {
    status: () => `Undoing last AI edits`,
    effect: "ROLLED_BACK",
    fence: false,
    remoteSurface: false,
  },
  run_subagent: {
    label: "Subagent",
    status: (a) => `Spawning ${String(a.type ?? "subagent")} subagent`,
    summary: (a) => str(a, "description") ?? str(a, "type"),
    effect: "NONE",
    fence: false,
    remoteSurface: false,
  },
  send_to_project: {
    label: "Group send",
    approvalLabel: "Send to project agent",
    status: (a) => `Delegating to ${String(a.project ?? "project")}`,
    summary: (a) => str(a, "message"),
    effect: "NONE",
    fence: true,
    remoteSurface: false,
  },
  project_status: {
    label: "Group status",
    status: (a) => `Checking ${String(a.project ?? "project")}`,
    summary: (a) => str(a, "project"),
    effect: "NONE",
    fence: false,
    remoteSurface: false,
  },
  save_memory: {
    approvalLabel: "Save memory",
    status: (a) =>
      `Saving to memory: ${ellipsize(String(a.entry ?? ""), 40)}`,
    effect: "COMMITTED",
    fence: true,
    remoteSurface: false,
  },

  // ── Terminal surfaces / media ─────────────────────────────────────────
  suggest_command: {
    label: "Suggest",
    status: (a) =>
      `Suggesting ${ellipsize(String(a.command ?? ""), 60)}`,
    summary: (a) => str(a, "intent") ?? str(a, "description"),
    effect: "NONE",
    fence: true,
    remoteSurface: false,
  },
  open_preview: {
    label: "Preview",
    summary: (a) => str(a, "path") ?? str(a, "url"),
    effect: "NONE",
    fence: true,
    remoteSurface: false,
  },
  display_image: {
    label: "Display img",
    status: () => `Displaying image in terminal`,
    summary: (a) => str(a, "name"),
    effect: "NONE",
    fence: true,
    remoteSurface: false,
  },
  display_video: { label: "Display vid", effect: "NONE", fence: true, remoteSurface: false },
  look_at_screen: {
    summary: (a) => str(a, "display") ?? "screen",
    effect: "NONE",
    fence: true,
    remoteSurface: false,
  },
  generate_image: { effect: "NONE", fence: false, remoteSurface: false },
  generate_video: { effect: "NONE", fence: false, remoteSurface: false },

  // ── Conversion / scheduled work / MCP management ──────────────────────
  convert_to_pdf: {
    label: "Convert PDF",
    summary: (a) => str(a, "targetPath") ?? str(a, "sourcePath"),
    effect: "COMMITTED",
    fence: true,
    remoteSurface: false,
  },
  convert_image: {
    label: "Convert img",
    summary: (a) => str(a, "targetPath") ?? str(a, "sourcePath"),
    effect: "COMMITTED",
    fence: true,
    remoteSurface: false,
  },
  watch_create: {
    label: "Watch",
    approvalLabel: "Create watch",
    status: (a) => `Watching ${ellipsize(String(a.command ?? ""), 50)}`,
    summary: (a) => str(a, "label") ?? str(a, "command"),
    effect: "COMMITTED",
    fence: true,
    remoteSurface: false,
  },
  watch_list: {
    label: "Watches",
    effect: "NONE",
    fence: true,
    remoteSurface: false,
  },
  watch_kill: {
    label: "Unwatch",
    summary: (a) => str(a, "watch_id"),
    effect: "COMMITTED",
    fence: true,
    remoteSurface: false,
  },
  mcp_add_server: {
    label: "Add MCP",
    approvalLabel: "Register MCP server",
    summary: (a) => str(a, "name"),
    effect: "COMMITTED",
    fence: true,
    remoteSurface: false,
  },
  mcp_list_servers: {
    label: "MCP servers",
    effect: "NONE",
    fence: true,
    remoteSurface: false,
  },

  // ── Voice / radio ─────────────────────────────────────────────────────
  voice_settings: {
    label: "Voice",
    effect: "NONE", // read/list calls have no effect; changed[] → COMMITTED
    fence: true,
    remoteSurface: false,
  },
  play_radio: {
    label: "Radio",
    summary: (a) => str(a, "station"),
    effect: "COMMITTED",
    fence: true,
    remoteSurface: false,
  },
  stop_radio: {
    label: "Stop radio",
    effect: "COMMITTED",
    fence: true,
    remoteSurface: false,
  },
  radio_list_stations: {
    label: "Stations",
    effect: "NONE",
    fence: true,
    remoteSurface: false,
  },
  radio_now_playing: {
    label: "Now playing",
    summary: (a) => str(a, "station"),
    effect: "NONE",
    fence: true,
    remoteSurface: false,
  },
};

/** Every registered tool name, exported for inventory/coverage gates. */
export function registeredToolPresentations(): readonly string[] {
  return Object.keys(REGISTRY);
}

/** Resolve the presentation for a tool name, applying safe defaults. */
export function presentationFor(toolName: string): ToolPresentation {
  const row = REGISTRY[toolName];
  if (row) return row;
  // Unknown tool (MCP `server__name`, future additions): conservative —
  // fence everything, assume remote if namespaced, no side effects claimed.
  return {
    effect: "NONE",
    fence: true,
    remoteSurface: toolName.includes("__"),
  };
}
