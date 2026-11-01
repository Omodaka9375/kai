import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * UNIFIED ENGINE PANEL (2026-11-01) — one skeleton for EVERY engine card in
 * Settings → Voice. The panels had drifted into three different layouts
 * (STT API rows floating without a card, TTS API with two selects + caption,
 * local with an inline install button, AssemblyAI another variant). Now:
 *
 *   <VoiceEnginePanel label="…">
 *     <VoicePanelRow label="…"><controls…/></VoicePanelRow>   (repeatable)
 *     <VoiceKeyStatus …/> (optional, shared)
 *     <VoiceTestRow …/>   (optional — identical Test affordance everywhere)
 *   </VoiceEnginePanel>
 *
 * VoiceEnginePanel — the bordered card itself (same chrome for all engines).
 * VoicePanelRow — one "label right-controls" line inside it.
 * VoiceKeyStatus — the missing-key warning, shared by every API panel.
 * VoiceTestRow — the Test button + hint caption + status text, so testing
 *   a local model vs an API voice vs the mic looks IDENTICAL: same button
 *   style, same caption, same progress/result rendering.
 */

export function VoiceEnginePanel({
  label,
  children,
  className,
}: {
  /** Row label on the left (e.g. "Model", "Voice", "TTS model / voice"). */
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5",
        className,
      )}
    >
      <span className="text-[12.5px] font-medium">{label}</span>
      {children}
    </div>
  );
}

export function VoicePanelRow({
  label,
  children,
  last,
}: {
  label: string;
  children: ReactNode;
  /** Suppress the bottom padding on the LAST row of the card. */
  last?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-2",
        !last && "pb-2",
      )}
    >
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function VoiceKeyStatus({ message }: { message: ReactNode }) {
  return <div className="text-[11.5px] text-amber-500">{message}</div>;
}

export function VoiceTestRow({
  onTest,
  busy,
  disabled,
  testLabel,
  hint,
  statusText,
  error,
  disabledReason,
}: {
  onTest: () => void;
  /** Spinner label while the test runs (downloading / transcribing…). */
  busy?: string | null;
  /** Hard-disabled (e.g. local engine not installed yet). */
  disabled?: boolean;
  testLabel: string;
  /** Caption under the button — every panel gets the SAME caption style. */
  hint: string;
  /** Success/status line (e.g. "Engine installed — model: base.en"). */
  statusText?: ReactNode;
  /** Error line (red). */
  error?: ReactNode;
  /** Tooltip-ish explanation shown when the button is disabled. */
  disabledReason?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="-ml-2"
          disabled={!!busy || !!disabled}
          onClick={onTest}
        >
          {busy ?? testLabel}
        </Button>
        <span className="text-[11px] text-muted-foreground/70">{hint}</span>
      </div>
      {disabled && disabledReason ? (
        <span className="text-[11.5px] text-muted-foreground/70">
          {disabledReason}
        </span>
      ) : null}
      {statusText ? (
        <span className="text-[11.5px] text-emerald-500">{statusText}</span>
      ) : null}
      {error ? <span className="text-[11.5px] text-red-500">{error}</span> : null}
    </div>
  );
}
