import { cn } from "@/lib/utils";
import { AlertCircleIcon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { useChatStore } from "../store/chatStore";

type ErrorInfo = { context: string; pattern: string };

/** Auto-dismiss after this many ms if the user doesn't interact. */
const AUTO_DISMISS_MS = 15_000;

export function ErrorPrompt() {
  const [error, setError] = useState<ErrorInfo | null>(null);
  const hasComposer =
    useChatStore((s) => s.apiKeys) !== null;
  const openPanel = useChatStore((s) => s.openPanel);
  const focusInput = useChatStore((s) => s.focusInput);
  const attachSelection = useChatStore((s) => s.attachSelection);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ErrorInfo>).detail;
      if (detail?.context) setError(detail);
    };
    window.addEventListener("kai:terminal-error", handler);
    return () => window.removeEventListener("kai:terminal-error", handler);
  }, []);

  // Auto-dismiss timer.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [error]);

  const dismiss = useCallback(() => setError(null), []);

  const askToFix = useCallback(() => {
    if (!error) return;
    attachSelection(error.context, "terminal");
    openPanel();
    focusInput("Fix this error");
    setError(null);
  }, [error, attachSelection, openPanel, focusInput]);

  if (!hasComposer) return null;

  return (
    <AnimatePresence>
      {error && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          className={cn(
            "fixed bottom-12 left-1/2 z-50 -translate-x-1/2",
            "flex items-center gap-2.5 rounded-lg border border-destructive/30 bg-card px-3 py-2",
            "shadow-lg shadow-black/20 ring-1 ring-black/5 dark:ring-white/5",
          )}
        >
          <HugeiconsIcon
            icon={AlertCircleIcon}
            size={14}
            strokeWidth={1.75}
            className="shrink-0 text-destructive"
          />
          <span className="text-[12px] text-foreground">
            Error detected
          </span>
          <button
            type="button"
            onClick={askToFix}
            className="rounded-md bg-destructive/10 px-2.5 py-1 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/20"
          >
            Ask Kai to fix
          </button>
          <button
            type="button"
            onClick={dismiss}
            className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Dismiss"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
