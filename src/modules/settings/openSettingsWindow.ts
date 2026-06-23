import { invoke } from "@tauri-apps/api/core";

export type SettingsTab =
  | "general"
  | "shortcuts"
  | "models"
  | "agents"
  | "snippets"
  | "mcp"
  | "about";

export async function openSettingsWindow(tab?: string): Promise<void> {
  await invoke("open_settings_window", { tab: tab ?? null });
}
