import { invoke } from "@tauri-apps/api/core";

/** How API keys are stored on this machine (Rust-reported, not guessed). */
export type SecretsBackendInfo = {
  /** keychain | credential-manager | secret-service | file */
  backend: string;
  /** true when the backend encrypts at rest. */
  encrypted: boolean;
};

/**
 * Fetch the active key-storage backend. The Rust side probes the real
 * Secret Service on Linux (canary write/read/delete), so "secret-service"
 * means the daemon answered, never "we built an Entry and hoped".
 */
export function secretsBackendInfo(): Promise<SecretsBackendInfo> {
  return invoke<SecretsBackendInfo>("secrets_backend_info");
}
