import { useEffect, useMemo } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  MusicNote01Icon,
  PlayIcon,
  PauseIcon,
  VolumeHighIcon,
} from "@hugeicons/core-free-icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useRadioPlayer } from "./lib/useRadioPlayer";
import { RADIO_STATIONS } from "./lib/stations";
import { setRadioStationId } from "./radioPrefs";

/**
 * Status-bar radio widget — bounded marquee of what's playing + station
 * picker. Mounted ONLY when the feature is enabled (General settings), so
 * the disabled path is zero-cost. All player ops are fail-safe by contract
 * (see useRadioPlayer) — the marquee renders "stopped"/"error" states as
 * quiet text and never throws.
 */

const MARQUEE_MAX_WIDTH = "max-w-[420px]";

export function RadioMarquee() {
  const player = useRadioPlayer(null);
  // Derive from the shared controller via the hook — agent-driven station
  // changes (play_radio tool) and UI clicks highlight identically.
  const stationId = player.stationId;

  // Restore persisted station once on mount (fail-safe in the prefs lib).
  useEffect(() => {
    let cancelled = false;
    import("./radioPrefs")
      .then(({ getRadioStationId }) => getRadioStationId())
      .then((id) => {
        if (!cancelled && id) {
          player.play(id);
        }
      })
      .catch(() => {
        // radio unavailable — stay stopped. Never an unhandled rejection.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const statusText = useMemo(() => {
    const s = player.status;
    if (s.state === "stopped") return "SomaFM · pick a station";
    const station = s.station;
    if (!station) return "SomaFM";
    if (s.state === "connecting") return `${station.name} · connecting…`;
    if (s.state === "error") return `${station.name} · ${s.message}`;
    return `♪ ${station.name} · ${station.genre} · SomaFM`;
  }, [player.status]);

  const handleStationPick = (id: string) => {
    player.play(id);
    void setRadioStationId(id);
  };

  const handleStop = () => {
    player.stop();
    void setRadioStationId(null);
  };

  const playing = player.status.state === "playing";

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1 overflow-hidden",
        MARQUEE_MAX_WIDTH,
      )}
    >
      <button
        type="button"
        data-testid="radio-marquee"
        onClick={playing ? handleStop : stationId ? () => player.play(stationId) : undefined}
        title={playing ? "Stop radio" : "Play radio"}
        className="flex min-w-0 shrink cursor-default select-none items-center gap-1 rounded-full bg-muted/50 px-2 py-0.5 text-[10.5px] text-muted-foreground transition-colors hover:bg-muted"
      >
        <HugeiconsIcon
          icon={playing ? PauseIcon : MusicNote01Icon}
          size={11}
          strokeWidth={2}
          className={cn("shrink-0", playing && "text-emerald-500")}
        />
        <span className="truncate">{statusText}</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title="Pick a station"
            data-testid="radio-station-trigger"
            className="shrink-0 rounded-full p-1 text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
          >
            <HugeiconsIcon icon={VolumeHighIcon} size={11} strokeWidth={2} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          side="top"
          className="max-h-[50vh] min-w-48 overflow-y-auto"
        >
          <div className="px-1.5 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            SomaFM stations
          </div>
          {RADIO_STATIONS.map((s) => (
            <DropdownMenuItem
              key={s.id}
              onSelect={() => handleStationPick(s.id)}
              className={cn(
                "gap-2 text-xs",
                stationId === s.id && "bg-accent/40",
              )}
            >
              <HugeiconsIcon
                icon={stationId === s.id ? PlayIcon : MusicNote01Icon}
                size={11}
                strokeWidth={1.75}
                className={cn("shrink-0", stationId === s.id && "text-emerald-500")}
              />
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground/70">
                {s.genre}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}