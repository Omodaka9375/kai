/**
 * Credential vault — project-independent secrets (HF_TOKEN, passwords, keys,
 * vars) the agent can USE without ever SEEING the value.
 *
 * FLOW (2026-11-18, user-spec decisions locked):
 * - The USER adds/edits/removes entries in Settings → Security (UI-only
 *   writes; there is deliberately NO vault_set/vault_delete tool — a secret
 *   the agent could store would also live in the chat transcript on disk).
 * - The agent discovers NAMES via `vault_list` (metadata only) and passes
 *   `env: { HF_TOKEN: "vault:HF_TOKEN" }` to bash_run / bash_background.
 * - Rust resolves the reference into the child's environment at spawn time
 *   and masks echoes (<vault:VAR>) in the child's captured output. The value
 *   NEVER crosses the IPC boundary toward the model on any path.
 */
import { tool } from "ai";
import { z } from "zod";
import { invoke } from "@tauri-apps/api/core";
import type { VaultEntryInfo } from "../lib/native";
import type { ToolContext } from "./context";

/** Env-var schema shared by bash_run and bash_background. */
export const vaultEnvSchema = z
  .record(z.string(), z.string())
  .optional()
  .describe(
    "Environment variables for the command. A value of the form vault:NAME " +
    "injects the user's stored vault credential named NAME (Settings → Security) " +
    "into that variable — you never see or handle the value itself; it is resolved " +
    "securely by the host and masked as <vault:VAR> if the command echoes it. " +
    "Plain values are set verbatim.",
  );

export async function listVaultEntries(): Promise<VaultEntryInfo[]> {
  return invoke<VaultEntryInfo[]>("vault_list");
}

export function buildVaultTools(_ctx: ToolContext) {
  return {
    vault_list: tool({
      needsApproval: false,
      description:
        "List the user's stored credential vault entries — NAMES ONLY, never values. " +
        "To use one, pass env: { VAR: \"vault:NAME\" } to bash_run or bash_background; " +
        "the value is injected into the child process without ever being shown to you. " +
        "To add or change an entry, the USER does it in Settings → Security — you cannot " +
        "store secrets yourself, so ask them to.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const entries = await listVaultEntries();
          return {
            entries: entries.map((e) => ({
              name: e.name,
              updated_at: e.updated_at,
            })),
            total: entries.length,
            note:
              "Reference one with env: { VAR: \"vault:NAME\" } in bash_run / bash_background.",
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),
  };
}
