/**
 * Assistant tool catalog — the single source of truth for what the headless
 * Telegram assistant is *allowed* to be given, split by risk tier.
 *
 * Two separations matter:
 *
 *  1. HARD_EXCLUDED_TOOLS never reach the assistant at all, allowlist or not.
 *     These are tools coupled to the desktop UI (they render into a terminal
 *     tab, the screen, the radio, the plan panel, or spawn sub-agents / MCP
 *     servers) — calling them from a headless turn is either a no-op or an
 *     error, so they are not even offered in the picker.
 *
 *  2. The remaining SELECTABLE tools are grouped by RISK TIER and the user
 *     chooses which are enabled via Settings → Assistant (a chips-dropdown of
 *     `allowedTools`). The tiers exist so the DEFAULT can be safe: a fresh
 *     install runs READ-only — the assistant can look things up and reason,
 *     but cannot run a shell command, write a file, or spend an API credit
 *     until the owner explicitly grants that tier.
 *
 * This module imports NOTHING (pure data + helpers) so both the heavy agent
 * path (index.ts) and the lightweight settings window (ToolAllowlistPicker)
 * can share it without dragging in the AI runtime.
 */

export type ToolTier = "read" | "write" | "execute";

export type ToolEntry = {
  /** Tool key as registered by buildTools. */
  name: string;
  tier: ToolTier;
  /** One-line, shown as the chip tooltip. */
  blurb: string;
};

/** Tools the headless assistant can never use — desktop-UI-coupled. */
export const HARD_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  "display_image",
  "display_video",
  "get_terminal_output",
  "open_preview",
  "suggest_command",
  "look_at_screen",
  "play_radio",
  "stop_radio",
  "radio_list_stations",
  "radio_now_playing",
  "run_subagent",
  "checkpoint_undo",
  "mcp_add_server",
  "mcp_list_servers",
  "todo_write",
]);

/** Every selectable tool, grouped by tier. Order here is the picker order. */
export const TOOL_CATALOG: readonly ToolEntry[] = [
  // ── READ: no side effects — the safe default surface. ──────────────────
  { name: "web_search", tier: "read", blurb: "Search the web (DuckDuckGo)." },
  { name: "web_browse", tier: "read", blurb: "Fetch a web page's text." },
  { name: "read_file", tier: "read", blurb: "Read a file (scratch dir only)." },
  { name: "list_directory", tier: "read", blurb: "List a directory." },
  { name: "grep", tier: "read", blurb: "Search file contents." },
  { name: "glob", tier: "read", blurb: "Find files by name pattern." },
  { name: "watch_list", tier: "read", blurb: "List active background watches." },

  // ── WRITE: mutate files / state / spend API credits (fenced to scratch). ─
  { name: "write_file", tier: "write", blurb: "Create or overwrite a file." },
  { name: "edit", tier: "write", blurb: "Replace text in a file." },
  { name: "multi_edit", tier: "write", blurb: "Several edits to one file atomically." },
  { name: "batch_edit", tier: "write", blurb: "Edits across multiple files atomically." },
  { name: "create_directory", tier: "write", blurb: "Create a directory." },
  { name: "convert_to_pdf", tier: "write", blurb: "Convert md/txt/docx to PDF." },
  { name: "convert_image", tier: "write", blurb: "Convert / resize an image." },
  { name: "save_memory", tier: "write", blurb: "Persist a note to project memory." },
  { name: "generate_image", tier: "write", blurb: "Generate an image (API cost)." },
  { name: "generate_video", tier: "write", blurb: "Generate a video (API cost)." },
  { name: "voice_settings", tier: "write", blurb: "Change the reply voice / TTS." },

  // ── EXECUTE: run shell commands / schedules — highest risk. ────────────
  { name: "bash_run", tier: "execute", blurb: "Run a foreground shell command." },
  { name: "bash_background", tier: "execute", blurb: "Spawn a background process." },
  { name: "bash_logs", tier: "execute", blurb: "Read a background process's logs." },
  { name: "bash_list", tier: "execute", blurb: "List background processes." },
  { name: "bash_kill", tier: "execute", blurb: "Kill a background process." },
  { name: "watch_create", tier: "execute", blurb: "Schedule a recurring command watch." },
  { name: "watch_kill", tier: "execute", blurb: "Stop a watch." },
] as const;

export const TIER_LABELS: Record<ToolTier, string> = {
  read: "Read-only",
  write: "Write",
  execute: "Execute",
};

export const TIER_HINTS: Record<ToolTier, string> = {
  read: "Look things up and read — no side effects. Safe to leave on.",
  write: "Create / modify files and spend API credits (files stay in the assistant's scratch folder).",
  execute: "Run shell commands and schedules. Most powerful — enable only if you trust the model on your machine.",
};

/** Tools enabled on a fresh install: the READ tier only. */
export const DEFAULT_ALLOWED_TOOLS: readonly string[] = TOOL_CATALOG.filter(
  (t) => t.tier === "read",
).map((t) => t.name);

/** Names in a given tier (used by the picker's per-tier master toggle). */
export function toolsInTier(tier: ToolTier): string[] {
  return TOOL_CATALOG.filter((t) => t.tier === tier).map((t) => t.name);
}

/**
 * Should a tool reach the model, given the owner's allowlist?
 * Hard-excluded tools never do; MCP tools (namespaced `server__tool`) are
 * handled separately by server-id and never appear here.
 */
export function isToolAllowed(
  name: string,
  allowed: ReadonlySet<string> | readonly string[],
): boolean {
  if (HARD_EXCLUDED_TOOLS.has(name)) return false;
  const set = allowed instanceof Set ? allowed : new Set(allowed);
  return set.has(name);
}
