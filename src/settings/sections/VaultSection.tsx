import { useCallback, useEffect, useRef, useState } from "react";
import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon";
import LockKeyIcon from "@hugeicons/core-free-icons/LockKeyIcon";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { VaultEntryInfo } from "@/modules/ai/lib/native";
import { SectionHeader } from "../components/SectionHeader";

/**
 * Vault — the credential vault panel (2026-11-23 split from Security).
 *
 * Project-independent secrets (HF_TOKEN, passwords, keys) the agent can USE
 * without ever seeing. Writes are UI-ONLY by design — there is no vault_set
 * tool, so a secret can never transit the chat transcript. The agent
 * discovers names via vault_list and injects them as
 * env: { VAR: "vault:NAME" } on bash tools; Rust resolves the value into the
 * child process and masks echoes.
 *
 * Lives as its OWN settings panel (Settings → Vault) so the security audit
 * trail and the secret store read as separate surfaces — a vault sitting at
 * the bottom of the audit log conflated "what the agent did" with "what
 * secrets exist".
 */

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return sameDay ? time : `${d.toLocaleDateString()} ${time}`;
}

const VAULT_NAME_RE = /^[A-Za-z0-9_-]+$/;

export function VaultSection() {
  const [entries, setEntries] = useState<VaultEntryInfo[] | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const list = await invoke<VaultEntryInfo[]>("vault_list");
      if (aliveRef.current) setEntries(list);
    } catch (e) {
      if (aliveRef.current) {
        setError(String(e));
        setEntries([]);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const trimmedName = name.trim();
  const nameInvalid = trimmedName.length > 0 && !VAULT_NAME_RE.test(trimmedName);
  const willOverwrite = Boolean(
    trimmedName && entries?.some((e) => e.name === trimmedName),
  );
  const canAdd =
    trimmedName.length > 0 &&
    !nameInvalid &&
    value.trim().length > 0 &&
    !busy;

  const onAdd = async (ev?: React.FormEvent) => {
    ev?.preventDefault();
    if (!canAdd) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("vault_set", { name: trimmedName, value });
      if (aliveRef.current) {
        setName("");
        setValue("");
      }
      await refresh();
    } catch (e) {
      if (aliveRef.current) setError(String(e));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const onDelete = async (entryName: string) => {
    setBusy(true);
    setError(null);
    try {
      await invoke("vault_delete", { name: entryName });
      await refresh();
    } catch (e) {
      if (aliveRef.current) setError(String(e));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="Credential vault"
        description="Secrets stored in the OS keyring. The agent can use them in commands but never sees the values - only you can add or change them, here."
      />

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
          {error}
        </div>
      ) : null}

      {entries === null ? (
        <div className="py-3 text-center text-[11px] text-muted-foreground">
          Loading…
        </div>
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border/70 bg-card/30 px-4 py-8 text-center">
          <HugeiconsIcon
            icon={LockKeyIcon}
            size={20}
            strokeWidth={1.5}
            className="text-muted-foreground/60"
          />
          <div className="text-[12px] font-medium text-muted-foreground">
            No vault entries yet
          </div>
          <div className="max-w-64 text-[10.5px] leading-relaxed text-muted-foreground/70">
            Add a secret below (e.g. an API token). The agent references it as
            <span className="font-mono"> vault:NAME</span> in commands and the
            value is resolved invisibly.
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 rounded-2xl border border-border bg-card/50 p-3">
          <div className="px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
            {entries.length} entr{entries.length === 1 ? "y" : "ies"}
          </div>
          {entries.map((e) => (
            <div
              key={e.name}
              className="flex items-center gap-2 rounded-lg border border-border/50 bg-card/50 px-3 py-1.5"
            >
              <HugeiconsIcon
                icon={LockKeyIcon}
                size={12}
                strokeWidth={1.75}
                className="shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
                {e.name}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground/70">
                updated {formatTime(e.updated_at)}
              </span>
              <button
                type="button"
                aria-label={`Delete ${e.name}`}
                title="Delete entry"
                disabled={busy}
                onClick={() => void onDelete(e.name)}
                className="text-muted-foreground/70 transition-colors hover:text-destructive disabled:opacity-50"
              >
                <HugeiconsIcon icon={Delete02Icon} size={11} strokeWidth={1.75} />
              </button>
            </div>
          ))}
        </div>
      )}

      <form
        onSubmit={(ev) => void onAdd(ev)}
        className="flex flex-col gap-1.5 rounded-2xl border border-border bg-card/50 p-3"
      >
        <div className="px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
          {willOverwrite ? `Update "${trimmedName}"` : "Add a secret"}
        </div>
        <div className="flex gap-1.5">
          <Input
            value={name}
            onChange={(ev) => setName(ev.target.value)}
            placeholder="NAME (letters, digits, _ or -)"
            className="h-8 w-44 font-mono text-[11.5px] placeholder:text-[10px]"
            spellCheck={false}
            autoComplete="off"
          />
          <Input
            type="password"
            value={value}
            onChange={(ev) => setValue(ev.target.value)}
            placeholder="Value — never shown after save"
            className="h-8 flex-1 text-[11.5px] placeholder:text-[10px]"
            autoComplete="off"
          />
          <Button
            type="submit"
            size="sm"
            className="h-8"
            disabled={!canAdd}
          >
            {busy ? "Saving…" : willOverwrite ? "Update" : "Add"}
          </Button>
        </div>
        {nameInvalid ? (
          <div className="px-1 text-[10.5px] text-destructive">
            Use only letters, digits, underscores, or hyphens.
          </div>
        ) : willOverwrite ? (
          <div className="px-1 text-[10.5px] text-amber-600 dark:text-amber-400">
            An entry named <span className="font-mono">{trimmedName}</span> already exists and will be overwritten.
          </div>
        ) : null}
        <div className="px-1 text-[10.5px] leading-relaxed text-muted-foreground/70">
          The value is written to the OS keyring only. KAI never shows it back
          — not here, not in chat, not in tool output.
        </div>
      </form>
    </div>
  );
}