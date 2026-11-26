import { useEffect, useState } from "react";
import { foldLimitsFor, getHotWindowTokens } from "../lib/memochain";
import { native, type MemoChainSessionInfo } from "../lib/native";
import { getModelContextLimit } from "../config";

/**
 * MemoChain context-dropdown stats (2026-11-26 ask): when a session's model
 * is toggled for durable memory, the context dropdown swaps the regular
 * window/budget rows for FOLD stats - what the durable-memory handler is
 * actually doing - instead of the compaction-pressure numbers whose meaning
 * no longer applies (the handler owns context; local compaction is off).
 *
 * One component, both surfaces: the AI mini-window ContextIndicator and the
 * Workspaces CardContextRing render the same rows.
 */

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Poll the session's MemoChain state while the rows are mounted (the
 *  hover-card content only mounts while open, so this polls only while the
 *  user is looking at it). Null until the first reply lands. */
export function useMemoChainSessionInfo(
  sessionId: string | null,
): MemoChainSessionInfo | null {
  const [info, setInfo] = useState<MemoChainSessionInfo | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const load = () => {
      native
        .memochainSessionInfo(sessionId)
        .then((i) => {
          if (!cancelled) setInfo(i);
        })
        .catch(() => {
          // fail-open: the rows just show "no capsule yet"
        });
    };
    void load();
    const t = setInterval(load, 5_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [sessionId]);
  return info;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-muted-foreground">
      <span>{label}</span>
      <span className="font-mono text-foreground">{children}</span>
    </div>
  );
}

/** Compact fold/memory rows for a durable-memory (MemoChain) session.
 *  Replaces the regular window rows in both AiMiniWindow and Workspaces
 *  CardContextRing so the popover stays scannable at a glance. */
export function MemoChainContextRows({
  sessionId,
  modelId,
  used,
}: {
  sessionId: string | null;
  modelId: string;
  used: number;
}) {
  const info = useMemoChainSessionInfo(sessionId);
  const hot = foldLimitsFor(getModelContextLimit(modelId)).hotLimit;
  const exists = info?.exists ?? false;
  const tampered = info?.tampered ?? false;
  const step = info?.step ?? 0;
  const folded = info?.foldedHashes?.length ?? 0;
  // HOT WINDOW (2026-11-26 ask): the model-bound trimmed window the LAST
  // request actually carried (noted by agent.ts after each fold pass), NOT
  // the full-history estimate - the persisted Chat history grows forever, so
  // estimating from it made the row read "84k / 80k" permanently after the
  // first fold. Falls back to the estimate only before the first request on
  // a toggled model.
  const usedWindow = getHotWindowTokens(sessionId) ?? used;
  return (
    <>
      <div className="mt-1 flex items-center justify-between text-muted-foreground">
        <span>Hot window</span>
        <span className="font-mono text-foreground">
          {fmtTokens(usedWindow)} / {fmtTokens(hot)}
        </span>
      </div>
      <Row label="Folded">
        {exists ? `${folded} msgs (${step} ${step === 1 ? "step" : "steps"})` : "none yet"}
      </Row>
      <Row label="Capsule">
        <span
          title={exists && info?.stateDigest ? info.stateDigest : undefined}
          className={tampered ? "text-destructive" : undefined}
        >
          {!exists
            ? "not folded"
            : tampered
              ? "integrity failed"
              : "verified"}
        </span>
      </Row>
    </>
  );
}
