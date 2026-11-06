import { invoke } from "@tauri-apps/api/core";

export type SettingsTab =
  | "general"
  | "shortcuts"
  | "models"
  | "agents"
  | "snippets"
  | "mcp"
  | "sandbox"
  | "security"
  | "voice"
  | "assistant"
  | "about";

/** Open (or focus) a settings panel window. NEVER REJECTS: every call site
 *  is fire-and-forget (`void openSettingsWindow(...)`), so a rejection here
 *  escapes as an "Unhandled rejection" in the console (2026-11-06 report: a
 *  lagging project made a double-click race the window open and the
 *  duplicate-label error surfaced exactly that way). The Rust side now
 *  serializes opens - the race is fixed at the source; this catch is the
 *  belt-and-braces so ANY future command failure logs instead of leaking. */
export async function openSettingsWindow(tab?: string): Promise<void> {
  await invoke("open_settings_window", { tab: tab ?? null }).catch((e) => {
    console.error("[kai:settings] failed to open settings window:", e);
  });
}
