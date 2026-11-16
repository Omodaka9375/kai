import Shield01Icon from "@hugeicons/core-free-icons/Shield01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { useChatStore } from "../store/chatStore";
import { loadSandboxMode, SANDBOX_LABELS, subscribeSandboxChanged } from "../lib/sandbox";
import type { SandboxMode } from "../lib/native";

/** Session sandbox indicator — shows the active per-project policy mode. */
export function SandboxBadge() {
  const root = useChatStore((s) => s.live.getWorkspaceRoot());
  const [mode, setMode] = useState<SandboxMode>("off");

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

  if (mode === "off") return null;

  return (
    <span
      title={SANDBOX_LABELS[mode]}
      className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
    >
      <HugeiconsIcon icon={Shield01Icon} size={10} strokeWidth={1.75} />
      {mode === "readOnly" ? "read-only" : "workspace"}
    </span>
  );
}
