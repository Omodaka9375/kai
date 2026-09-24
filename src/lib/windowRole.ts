/**
 * Which webview this module graph runs in. KAI's Settings window is a
 * SEPARATE webview with its own JS realm — module singletons (like the MCP
 * client manager) are NOT shared with the main window.
 *
 * The main window owns all MCP server processes; the settings webview must
 * never spawn its own (a duplicate stdio server, e.g. Linear's OAuth flow,
 * collides with the first instance over the localhost callback port and
 * forces a re-authentication prompt on every Settings open).
 *
 * Default is "main" so any future webview that forgets to declare its role
 * keeps the historical behavior; `src/settings/main.tsx` opts out at startup.
 */
export type WindowRole = "main" | "settings";

let role: WindowRole = "main";

export function setWindowRole(r: WindowRole): void {
  role = r;
}

/** True when this webview owns shared singletons (MCP processes, etc.). */
export function isMainWindow(): boolean {
  return role === "main";
}