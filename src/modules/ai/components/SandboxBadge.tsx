import Shield01Icon from "@hugeicons/core-free-icons/Shield01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useChatStore } from "../store/chatStore";
import { auditAppend, AUDIT_KINDS } from "../lib/audit";
import { native } from "../lib/native";
import type { SandboxMode } from "../lib/native";
import {
  loadSandboxMode,
  notifySandboxConfigChanged,
  SANDBOX_LABELS,
  subscribeSandboxChanged,
} from "../lib/sandbox";

/** Same order/wording as Settings → Sandbox, so both surfaces read as one
 *  control. Descriptions are one line each — the pill is compact, not a
 *  settings page. */
const MODES: { id: SandboxMode; label: string; hint: string }[] = [
  { id: "off", label: "Off", hint: "No sandboxing" },
  { id: "readOnly", label: "Read-only", hint: "Writes confined to the project" },
  { id: "workspaceOnly", label: "Workspace only", hint: "All IO confined to the project" },
];

const SHORT: Record<SandboxMode, string> = {
  // "off" renders ICON-ONLY (2026-11-17 ask): a dimmed shield with no label
  // reads as "inactive" without the noisy "off" text; an active mode keeps
  // its label so the user sees WHICH confinement is on at a glance.
  off: "",
  readOnly: "read-only",
  workspaceOnly: "workspace",
};

/**
 * Session sandbox indicator + picker. Shows the active per-project policy
 * mode and lets the user change it in place (2026-11-16: previously
 * read-only status; the mode was only changeable in Settings → Sandbox).
 * Renders whenever a workspace root exists — INCLUDING "off", dimmed, so
 * the sandbox can be turned ON from here; a hidden pill can't be clicked.
 */
export function SandboxBadge() {
  const root = useChatStore((s) => s.live.getWorkspaceRoot());
  const [mode, setMode] = useState<SandboxMode>("off");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadSandboxMode(root).then((m) => {
      if (alive) setMode(m);
    });
    // Settings → Sandbox lives in a separate webview; subscribe to its
    // change event so the badge re-reads (post-invalidation) live. The
    // old effect keyed on [root] only — a mode change never re-ran it.
    let unlisten: (() => void) | null = null;
    void subscribeSandboxChanged(() => {
      void loadSandboxMode(root).then((m) => {
        if (alive) setMode(m);
      });
    }).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [root]);

  // No project open — sandboxing is a no-op without a root; nothing to
  // show or change.
  if (!root) return null;

  const onPick = async (next: SandboxMode) => {
    if (!root || saving || next === mode) return;
    setSaving(true);
    // Optimistic: the pill reflects the click immediately; a failed save
    // re-reads and reverts (and stays honest about the on-disk config).
    setMode(next);
    try {
      await native.sandboxSaveConfig(root, next);
      // Broadcast FIRST, then audit — the broadcast is what makes every
      // window (this one included, via the subscription above) re-read.
      notifySandboxConfigChanged();
      auditAppend(
        AUDIT_KINDS.sandboxChange,
        "sandbox-pill",
        `mode → ${next}`,
        root,
      );
    } catch (e) {
      console.error("sandbox pill: failed to save config", e);
      void loadSandboxMode(root).then((m) => setMode(m));
    } finally {
      setSaving(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        asChild
        disabled={saving}
        title={`${SANDBOX_LABELS[mode]} — click to change`}
        className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium outline-none transition-colors data-[state=open]:bg-primary/15 focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
      >
        <span
          className={
            mode === "off"
              ? "inline-flex items-center gap-1 text-muted-foreground/80"
              : "inline-flex items-center gap-1 text-primary"
          }
        >
          <HugeiconsIcon
            icon={Shield01Icon}
            // 11px (2026-11-18): matches the persona/expand/minimize icons in
            // the same mini-window header — 10px read visibly smaller/off.
            size={11}
            strokeWidth={1.75}
          />
          {SHORT[mode] ? (
            <span>{SHORT[mode]}</span>
          ) : null}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-56">
        <DropdownMenuRadioGroup
          value={mode}
          onValueChange={(v) => void onPick(v as SandboxMode)}
        >
          {MODES.map((m) => (
            <DropdownMenuRadioItem key={m.id} value={m.id} className="py-1.5">
              <span className="flex flex-col items-start gap-0.5">
                <span className="text-[12px] font-medium">{m.label}</span>
                <span className="text-[10.5px] text-muted-foreground">
                  {m.hint}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
