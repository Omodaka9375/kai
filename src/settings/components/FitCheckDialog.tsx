/**
 * Model fit check — a fast (~60–90s), decisive test of the SELECTED model's
 * ability to drive KAI's coding agent. Three tiny missions (surgical fix,
 * fix-and-recover, read-only control) run against throwaway fixtures with the
 * real tool schemas; grading is deterministic (independent test re-run +
 * file hashing), never trusting the model's claims.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  CheckmarkCircle02Icon,
  Cancel01Icon,
  TestTubeIcon,
  Loading01Icon,
} from "@hugeicons/core-free-icons";
import { getModel } from "@/modules/ai/config";
import { buildConfiguredLanguageModel } from "@/modules/ai/lib/agent";
import type { ProviderKeys } from "@/modules/ai/lib/keyring";
import { runFitCheck, type FitCheckReport } from "@/modules/ai/lib/fitCheck/runner";
import { usePreferencesStore } from "@/modules/settings/preferences";

type Phase = "idle" | "running" | "done" | "error";

const VERDICT_TEXT: Record<FitCheckReport["verdict"], { label: string; tone: string }> = {
  ready: { label: "READY", tone: "text-emerald-500" },
  flaky: { label: "FLAKY", tone: "text-amber-500" },
  "chat-only": { label: "CHAT-ONLY", tone: "text-sky-500" },
  "not-recommended": { label: "NOT RECOMMENDED", tone: "text-destructive" },
  inconclusive: { label: "INCONCLUSIVE", tone: "text-muted-foreground" },
};

export function FitCheckDialog({
  open,
  onOpenChange,
  modelId,
  keys,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  modelId: import("@/modules/ai/config").ModelId;
  keys: ProviderKeys;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<string | null>(null);
  const [report, setReport] = useState<FitCheckReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  useEffect(() => {
    if (!open) {
      stop();
      setPhase("idle");
      setReport(null);
      setProgress(null);
      setError(null);
    }
  }, [open, stop]);

  const start = useCallback(async () => {
    setPhase("running");
    setProgress("Loading model…");
    setError(null);
    setReport(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const m = getModel(modelId);
      const prefs = usePreferencesStore.getState();
      const model = await buildConfiguredLanguageModel(
        modelId,
        keys,
        prefs.lmstudioBaseURL,
        prefs.lmstudioModelId,
        prefs.openaiCompatibleBaseURL,
        prefs.openaiCompatibleModelId,
      );
      const local =
        m.provider === "lmstudio" || m.provider === "openai-compatible";
      const rep = await runFitCheck({
        model,
        modelId,
        provider: m.provider,
        thinkingMode: prefs.thinkingMode,
        local,
        abortSignal: controller.signal,
        onProgress: setProgress,
      });
      setReport(rep);
      setPhase("done");
    } catch (e) {
      setError(String(e));
      setPhase("error");
    } finally {
      abortRef.current = null;
    }
  }, [modelId, keys]);

  const verdict = report ? VERDICT_TEXT[report.verdict] : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-4 rounded-2xl p-5">
        <DialogHeader className="pr-8">
          <DialogTitle className="flex items-center gap-2">
            <HugeiconsIcon icon={TestTubeIcon} size={16} strokeWidth={1.75} />
            Model fit check
          </DialogTitle>
          <DialogDescription>
            Three ~20s missions with real Kai tool schemas on throwaway
            fixtures. Graded by independently re-running the tests — never by
            trusting the model's claims.
          </DialogDescription>
        </DialogHeader>

        <div className="text-[11.5px] text-muted-foreground">
          Model:{" "}
          <span className="font-medium text-foreground">{modelId}</span>
        </div>

        {phase === "running" ? (
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <HugeiconsIcon
              icon={Loading01Icon}
              size={14}
              strokeWidth={1.75}
              className="animate-spin"
            />
            {progress ?? "Running…"}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="ml-auto h-7 px-2 text-[11px]"
              onClick={stop}
            >
              Cancel
            </Button>
          </div>
        ) : null}

        {phase === "error" ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-[12px] text-destructive">
            {error}
          </div>
        ) : null}

        {report && verdict ? (
          <div className="flex flex-col gap-2.5">
            <div
              className={cn(
                "rounded-lg border px-3 py-2 text-center text-[13px] font-semibold tracking-wide",
                report.verdict === "ready" && "border-emerald-500/40 bg-emerald-500/10",
                report.verdict === "flaky" && "border-amber-500/40 bg-amber-500/10",
                report.verdict === "chat-only" && "border-sky-500/40 bg-sky-500/10",
                report.verdict === "not-recommended" && "border-destructive/40 bg-destructive/10",
                report.verdict === "inconclusive" && "border-border bg-muted/30",
              )}
            >
              <span className={verdict.tone}>{verdict.label}</span>
              <span className="ml-2 font-normal text-muted-foreground">
                {report.summary} · {(report.totalDurationMs / 1000).toFixed(0)}s
              </span>
            </div>

            {report.missions.map((m) => (
              <div
                key={m.fixtureId}
                className="flex flex-col gap-1 rounded-lg border border-border/50 p-2"
              >
                <div className="flex items-center gap-1.5 text-[12px] font-medium">
                  <HugeiconsIcon
                    icon={m.verdict.pass ? CheckmarkCircle02Icon : Cancel01Icon}
                    size={13}
                    strokeWidth={1.9}
                    className={m.verdict.pass ? "text-emerald-500" : "text-destructive"}
                  />
                  {m.title}
                </div>
                {m.verdict.reason ? (
                  <div className="text-[10.5px] leading-4 text-muted-foreground">
                    {m.verdict.reason}
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
                  {m.verdict.checks.map((c) => (
                    <span key={c.label} className={c.pass ? "" : "text-destructive"}>
                      {c.pass ? "✓" : "✗"} {c.label}
                    </span>
                  ))}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {m.calls.map((c) => c.tool).join(" → ") || "(no tool calls)"}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {phase !== "running" ? (
          <Button type="button" onClick={() => void start()}>
            {report ? "Run again" : "Start test"}
          </Button>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}