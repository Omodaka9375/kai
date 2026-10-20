import { useCallback, useEffect, useState } from "react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openPath } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import {
  auditAppend,
  AUDIT_KINDS,
  auditClear,
  auditDirPath,
  auditRecent,
  type AuditEvent,
} from "@/modules/ai/lib/audit";
import { listCommands, unpinCommand, allowlistDirFor } from "@/modules/ai/lib/allowlist";
import { setNetworkPolicy } from "@/modules/settings/store";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";
import { cn } from "@/lib/utils";

/**
 * Security — the agent audit trail viewer.
 *
 * The trail is append-only JSONL at ~/.kai/audit/ (outside any project), with
 * credential-shaped values scrubbed on the Rust side before they touch disk.
 * This panel is read-only over it: recent events, open-in-explorer, clear.
 */

const KIND_STYLE: Record<string, string> = {
  "approval.approve": "text-emerald-600 dark:text-emerald-400",
  "approval.deny": "text-amber-600 dark:text-amber-400",
  "security.deny": "text-red-600 dark:text-red-400",
  "sandbox.change": "text-blue-600 dark:text-blue-400",
  "assistant.exec": "text-violet-600 dark:text-violet-400",
};

const KIND_LABEL: Record<string, string> = {
  "approval.approve": "Approved",
  "approval.deny": "Denied",
  "security.deny": "Blocked",
  "sandbox.change": "Sandbox",
  "assistant.exec": "Telegram",
  "tool.exec": "Tool",
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString()} ${time}`;
}

export function SecuritySection() {
  const networkPolicy = usePreferencesStore((s) => s.networkPolicy);

  const onNetworkPolicy = (v: "full" | "lan") => {
    if (v === networkPolicy) return;
    void setNetworkPolicy(v);
    auditAppend(
      AUDIT_KINDS.sandboxChange,
      "network",
      v === "lan" ? "network policy: LAN only" : "network policy: full access",
      "",
    );
  };

  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Scoped allowlist (per-project). The settings window has no live
  // workspace binding — use the last workspace as the project key, same
  // as the sandbox panel.
  const root = usePreferencesStore((s) => s.lastWorkspaceCwd) || "";
  const [pinned, setPinned] = useState<string[]>([]);
  const [listDir, setListDir] = useState<string | null>(null);
  const refreshPinned = useCallback(() => {
    if (!root) {
      setPinned([]);
      return;
    }
    void listCommands(root)
      .then((entries) => {
        setPinned(entries.map((e) => e.command));
      })
      .catch(() => setPinned([]));
    void allowlistDirFor(root).then(setListDir).catch(() => setListDir(null));
  }, [root]);
  useEffect(() => {
    refreshPinned();
  }, [refreshPinned]);

  const onUnpin = async (command: string) => {
    if (!root) return;
    await unpinCommand(root, command);
    refreshPinned();
  };

  const refresh = useCallback(() => {
    auditRecent(100)
      .then(setEvents)
      .catch((e) => {
        setError(String(e));
        setEvents([]);
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onOpenFolder = async () => {
    try {
      const p = await auditDirPath();
      await openPath(p);
    } catch (e) {
      setError(String(e));
    }
  };

  const onClear = async () => {
    setBusy(true);
    setError("");
    try {
      await auditClear();
      setEvents([]);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Security"
        description="Append-only record of agent actions: what you approved, what was blocked, sandbox changes, and headless (Telegram) runs. Lives outside your projects at ~/.kai/audit — agent code cannot rewrite it. Credential-shaped values are scrubbed before anything is written."
      />

      <SettingRow
        title="Agent network access"
        description={
          networkPolicy === "lan"
            ? "Agent web tools and shell commands can reach the LAN (intranet hostnames, local model servers) but not the public internet. Model provider calls, your MCP servers, and the API tester are never restricted — the agent must stay able to think, and human-configured endpoints are trusted. Policy layer, not an OS firewall: for hard confinement use Sandbox → Workspace only."
            : "Unrestricted. The agent's web tools may fetch any public URL (SSRF guard still blocks LAN/metadata), and shell commands may reach the internet."
        }
      >
        <div className="flex items-center gap-1">
          {(["full", "lan"] as const).map((v) => (
            <Button
              key={v}
              size="sm"
              variant={networkPolicy === v ? "default" : "outline"}
              onClick={() => onNetworkPolicy(v)}
              className="h-7 px-3 text-[11px]"
            >
              {v === "full" ? "Full access" : "LAN only"}
            </Button>
          ))}
        </div>
      </SettingRow>

      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card/50 p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium">Audit trail</span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => void onOpenFolder()}>
              Open folder
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void onClear()}
              disabled={busy || !events || events.length === 0}
            >
              {busy ? "Clearing…" : "Clear"}
            </Button>
          </div>
        </div>

        {events === null ? (
          <div className="py-6 text-center text-[11.5px] text-muted-foreground">
            Loading…
          </div>
        ) : events.length === 0 ? (
          <div className="py-6 text-center text-[11.5px] text-muted-foreground">
            No events yet. Approvals, blocked paths, sandbox changes, and
            Telegram turns will appear here.
          </div>
        ) : (
          <div className="max-h-110 overflow-y-auto rounded-lg border border-border/60">
            {events.map((e, i) => (
              <div
                key={`${e.ts}-${i}`}
                className={cn(
                  "flex items-baseline gap-3 px-3 py-1.5 text-[11.5px]",
                  i > 0 && "border-t border-border/40",
                )}
              >
                <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground/70">
                  {formatTime(e.ts)}
                </span>
                <span
                  className={cn(
                    "w-16 shrink-0 font-medium",
                    KIND_STYLE[e.kind] ?? "text-muted-foreground",
                  )}
                >
                  {KIND_LABEL[e.kind] ?? e.kind}
                </span>
                <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground/80">
                  {e.subject}
                </span>
                <span className="min-w-0 flex-1 break-all text-foreground/90">
                  {e.summary}
                </span>
              </div>
            ))}
          </div>
        )}

        {error ? <span className="text-[11.5px] text-red-500">{error}</span> : null}
      </div>

      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card/50 p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium">Always-allowed commands</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => (listDir ? void openPath(listDir) : undefined)}
            disabled={!listDir}
          >
            Open folder
          </Button>
        </div>
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">
          Commands pinned from approval cards run without asking — exact-match
          only, per project, low-risk commands only. A chained or modified
          variant always prompts again. The store lives outside your project,
          where agent tools cannot write it.
        </p>
        {pinned.length === 0 ? (
          <div className="py-4 text-center text-[11.5px] text-muted-foreground">
            Nothing pinned yet. Use "Always allow" on an approval card.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border/60">
            {pinned.map((command, i) => (
              <div
                key={command}
                className={cn(
                  "flex items-center gap-2 px-3 py-1.5",
                  i > 0 && "border-t border-border/40",
                )}
              >
                <code className="min-w-0 flex-1 break-all font-mono text-[11px]">
                  {command}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  aria-label={"Remove " + command}
                  title="Remove — this command will prompt again"
                  onClick={() => void onUnpin(command)}
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <SettingRow
        title="What gets recorded"
        description="Approve/deny decisions on tool cards, security-layer rejections (secret paths, sandbox violations), sandbox mode changes, and every Telegram assistant turn. Not recorded: file contents, tool output bodies, or your prompts beyond a short excerpt already scrubbed of secrets."
      >
        <span />
      </SettingRow>
    </div>
  );
}
