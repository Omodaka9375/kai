import {
  AlertCircleIcon,
  Copy02Icon,
  Delete02Icon,
  Shield01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";
import {
  discardShadow,
  formatMergeReport,
  loadShadow,
  mergeShadow,
  onShadowChange,
} from "../lib/shadow";
import type { ShadowInfo } from "../lib/native";
import { useChatStore } from "../store/chatStore";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";

type Props = {
  sessionId: string | null;
};

/**
 * Shadow mode strip — the single user-facing surface for the isolated-copy
 * workflow. Vocabulary contract (memorize): the strip's buttons are
 * "Apply" (copy the isolated FILES back into the real project) and "Discard"
 * (delete the copy). The word "Merge" is reserved for the SESSION menu's
 * merge-into-another-chat action — same word previously meant opposite things
 * three inches apart, which is why users couldn't tell fork from copy.
 * Starting Shadow mode lives on the strip (below) and in the session dropdown.
 */
export function ShadowStrip({ sessionId }: Props) {
  const root = useChatStore((s) => s.live.getWorkspaceRoot());
  const [shadow, setShadow] = useState<ShadowInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);
  const [version, setVersion] = useState(0);

  // Shadow state is module-resident, not a store — subscribe to mutations
  // from anywhere (dropdown start, apply, discard) and re-resolve.
  useEffect(() => onShadowChange(() => setVersion((v) => v + 1)), []);

  // Transient report/error clears when the project or session changes.
  useEffect(() => {
    setMessage("");
  }, [root, sessionId]);

  useEffect(() => {
    let alive = true;
    setShadow(null);
    if (!root) return;
    void loadShadow(root).then((info) => {
      if (alive) setShadow(info);
    });
    return () => {
      alive = false;
    };
  }, [root, sessionId, version]);

  const onApply = async () => {
    if (!root || busy) return;
    setBusy(true);
    try {
      const report = await mergeShadow(root, false);
      setMessage(formatMergeReport(report));
      setIsError(report.conflicts.length > 0);
    } catch (e) {
      setIsError(true);
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDiscard = async () => {
    if (!root || busy) return;
    setBusy(true);
    setMessage("");
    try {
      await discardShadow(root);
    } catch (e) {
      setIsError(true);
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!root) return null;

  if (!shadow) {
    // No active shadow: surface the leftover apply report or an error — and
    // the one-click entry point (the strip is always visible in the pane).
    if (!message) return null;
    return (
      <div className="flex shrink-0 items-center gap-2 border-t border-border/80 bg-primary/5 px-3 py-1.5">
        <HugeiconsIcon
          icon={isError ? AlertCircleIcon : Shield01Icon}
          size={12}
          strokeWidth={1.75}
          className={cn(
            "shrink-0",
            isError ? "text-red-500" : "text-muted-foreground",
          )}
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[11px]",
            isError ? "text-red-500" : "text-muted-foreground",
          )}
          title={message}
        >
          {message}
        </span>
      </div>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-border/80 bg-primary/5 px-3 py-1.5">
      <HugeiconsIcon
        icon={Shield01Icon}
        size={12}
        strokeWidth={1.75}
        className="shrink-0 text-primary"
      />
      <span className="min-w-0 flex-1 truncate text-[11px]">
        <span className="font-medium">Shadow mode</span>
        <span className="text-muted-foreground">
          {" "}— working on an isolated copy of your files{shadow.sharedDirs.length > 0 ? ` (${shadow.sharedDirs.join(", ")} shared)` : ""}
        </span>
      </span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-6 px-2 text-[11px]"
        disabled={busy}
        onClick={() => void onApply()}
        title="Copy the changes made in Shadow mode back into the real project"
      >
        <HugeiconsIcon icon={Copy02Icon} size={11} strokeWidth={1.75} />
        Apply
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-6 px-2 text-[11px]"
        disabled={busy}
        onClick={() => void onDiscard()}
        title="Delete the isolated copy — the real project keeps nothing from it"
      >
        <HugeiconsIcon icon={Delete02Icon} size={11} strokeWidth={1.75} />
        Discard
      </Button>
      {message ? (
        <span
          className={cn(
            "flex items-center gap-1 truncate text-[11px]",
            isError ? "text-amber-500" : "text-muted-foreground",
          )}
          title={message}
        >
          {isError ? (
            <HugeiconsIcon icon={AlertCircleIcon} size={11} strokeWidth={1.75} className="shrink-0" />
          ) : null}
          <span className="truncate">{message}</span>
        </span>
      ) : null}
    </div>
  );
}

/**
 * "Shadow mode" entry action for the session dropdown — the consolidated A+B
 * flow: starts the isolated file copy AND forks the conversation in one
 * action, so users learn a single concept. Hidden while a shadow is active
 * (the strip then owns Apply/Discard) and when no project is open. Radix
 * closes the menu as soon as onSelect returns without awaiting async work —
 * onSelect preventDefaults to keep the menu open during creation and on
 * failure; `close()` runs on success.
 */
export function ShadowSessionMenuItem({ close }: { close: () => void }) {
  const root = useChatStore((s) => s.live.getWorkspaceRoot());
  // null = resolving, false = no shadow (show), true = active (hide)
  const [state, setState] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setState(null);
    if (!root) return;
    void loadShadow(root).then((info) => {
      if (alive) setState(info != null);
    });
    return () => {
      alive = false;
    };
  }, [root]);

  useEffect(
    () =>
      onShadowChange(() => {
        if (!root) return;
        void loadShadow(root).then((info) => setState(info != null));
      }),
    [root],
  );

  const start = async () => {
    if (!root || busy) return;
    setBusy(true);
    setError("");
    try {
      const newId = await useChatStore.getState().startShadowMode();
      if (newId == null) {
        setError("Could not start Shadow mode — the isolated copy failed to create.");
        return;
      }
      close();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!root || state !== false) return null;

  // Single-line item, matching the sibling entries: the long Apply/Discard
  // explanation lives in the tooltip — a stacked multi-line block here
  // stretched the whole dropdown vertically.
  return (
    <>
      <DropdownMenuItem
        onSelect={(e) => {
          e.preventDefault();
          void start();
        }}
        disabled={busy}
        className="gap-2 text-xs"
        title="Try changes safely: edits go to an isolated copy of the files and a branched conversation. Apply copies the changes back, Discard deletes them. (Fork branches the conversation only.)"
      >
        <HugeiconsIcon icon={Shield01Icon} size={12} strokeWidth={1.75} />
        {busy ? "Starting Shadow mode…" : "Shadow mode"}
      </DropdownMenuItem>
      {error ? (
        <div
          className="px-2 py-1 text-[10.5px] text-red-500"
          title={error}
        >
          <span className="block truncate">{error}</span>
        </div>
      ) : null}
    </>
  );
}
