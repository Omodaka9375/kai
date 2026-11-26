import { useEffect, useState } from "react";
import { foldLimitsFor } from "../lib/memochain";
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

/** The fold/memory rows replacing the Window / Model window / Reserved block
 *  on a durable-memory session. `used` is the caller's context estimate -
 *  shown against the handler's hot-window budget (the point at which the
 *  next fold fires), not the compaction thresholds. */
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
  return (
    <>
      <div className="mt-1 flex items-center justify-between text-muted-foreground">
        <span>Hot window</span>
        <span className="font-mono text-foreground">
          {fmtTokens(used)} / {fmtTokens(hot)}
        </span>
      </div>
      <Row label="Fold steps">
        {exists ? step : "-"}
      </Row>
      <Row label="Folded messages">
        {exists ? folded : "-"}
      </Row>
      <Row label="Memory state">
        {!exists
          ? "no capsule yet"
          : tampered
            ? "INTEGRITY CHECK FAILED"
            : "verified"}
      </Row>
      {exists && info?.stateDigest ? (
        <div
          className="flex items-center justify-between gap-2 text-muted-foreground"
          title={info.stateDigest}
        >
          <span>State digest</span>
          <span className="font-mono text-foreground">
            {info.stateDigest.slice(0, 10)}
          </span>
        </div>
      ) : null}
    </>
  );
}
