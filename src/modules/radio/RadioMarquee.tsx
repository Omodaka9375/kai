import { useEffect, useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  MusicNote01Icon,
  PlayIcon,
  StopIcon,
  VolumeHighIcon,
  VolumeOffIcon,
} from "@hugeicons/core-free-icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { useRadioPlayer } from "./lib/useRadioPlayer";
import {
  RADIO_STATIONS,
  findStation,
} from "./lib/stations";
import {
  radioGetMuted,
  radioGetVolume,
  radioSetMuted,
  radioSetVolume,
} from "./lib/radioControl";
import { setRadioStationId } from "./radioPrefs";

/**
 * Status-bar radio widget. Controls:
 *  - The pill (station name) opens the STATION PICKER.
 *  - The speaker icon toggles MUTE directly; a thin inline volume slider
 *    sits in the same row (no popover).
 * Mounted ONLY when the feature is enabled (General settings).
 */

const MARQUEE_MAX_WIDTH = "max-w-[420px]";

export function RadioMarquee() {
  const player = useRadioPlayer();
  const [muted, setMuted] = useState(radioGetMuted());
  const [volume, setVolume] = useState(radioGetVolume());
  // The persisted station id is the *selection* (picker highlight) only —
  // NO auto-resume on launch. Starting the app must never blast audio;
  // the user starts playback per session (click or agent tool).
  const [stationId, setStationIdLocal] = useState<string | null>(null);

  // Restore the persisted station SELECTION once on mount (fail-safe in the
  // prefs lib). Deliberately does not play — see above.
  useEffect(() => {
    let cancelled = false;
    import("./radioPrefs")
      .then(({ getRadioStationId }) => getRadioStationId())
      .then((id) => {
        if (!cancelled && id) {
          setStationIdLocal(id);
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
    setStationIdLocal(id);
    player.play(id);
    void setRadioStationId(id);
  };

  const handleMuteToggle = () => {
    const next = !muted;
    setMuted(next);
    radioSetMuted(next);
  };

  const handleVolume = (v: number) => {
    setVolume(v);
    radioSetVolume(v);
    if (v > 0 && muted) {
      setMuted(false);
      radioSetMuted(false);
    }
  };

  // Stop WITHOUT clearing the selection — the picker highlight survives so
  // the next open offers the same station first.
  const handleStop = () => {
    player.stop();
  };

  const playing = player.status.state === "playing";
  const connecting = player.status.state === "connecting";
  const active = playing || connecting;
  const station = stationId ? findStation(stationId) : null;

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1 overflow-hidden",
        MARQUEE_MAX_WIDTH,
      )}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid="radio-marquee"
            title="Pick a station"
            className={cn(
              "flex min-w-0 shrink cursor-default select-none items-center gap-1 rounded-full bg-muted/50 px-2 py-0.5 text-[10.5px] text-muted-foreground transition-colors hover:bg-muted",
              (playing || connecting) && "text-foreground",
            )}
          >
            <HugeiconsIcon
              icon={playing ? MusicNote01Icon : PlayIcon}
              size={11}
              strokeWidth={2}
              className={cn("shrink-0", playing && "text-emerald-500")}
            />
            <span className="truncate">{statusText}</span>
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
          {active && (
            <>
              <DropdownMenuItem
                onSelect={handleStop}
                className="gap-2 text-xs"
              >
                <HugeiconsIcon
                  icon={StopIcon}
                  size={11}
                  strokeWidth={1.75}
                  className="shrink-0"
                />
                <span className="min-w-0 flex-1 truncate">Stop playback</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
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
                icon={MusicNote01Icon}
                size={11}
                strokeWidth={1.75}
                className={cn(
                  "shrink-0",
                  stationId === s.id && "text-emerald-500",
                )}
              />
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground/70">
                {s.genre}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Mute toggle + volume in ONE row: the speaker icon toggles mute
          directly, and a thin inline slider extends to the right — no
          popover, no second mute button. */}
      <button
        type="button"
        title={muted ? "Unmute" : "Mute"}
        aria-label={muted ? "Unmute radio" : "Mute radio"}
        aria-pressed={muted}
        onClick={handleMuteToggle}
        data-testid="radio-mute-toggle"
        className="shrink-0 rounded-full p-1 text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
      >
        <HugeiconsIcon
          icon={muted ? VolumeOffIcon : VolumeHighIcon}
          size={11}
          strokeWidth={2}
        />
      </button>
      <Slider
        value={[volume]}
        min={0}
        max={1}
        step={0.05}
        onValueChange={(v) => handleVolume(v[0] ?? 1)}
        aria-label="Radio volume"
        className={cn(
          "w-14 shrink-0",
          // Thin-inline overrides of the chunky default slider: 4px track,
          // 8px thumb (the primitive ships h-2 track / h-4 w-6 thumb).
          "[&_[data-slot=slider-track]]:h-1",
          "[&_[data-slot=slider-thumb]]:size-2",
          "[&_[data-slot=slider-thumb]]:w-2",
          "[&_[data-slot=slider-thumb]]:ring-0",
          "[&_[data-slot=slider-thumb]]:shadow-none",
        )}
      />
      {/* Screen-reader/live region only — the visual status is in the pill. */}
      <span className="sr-only">{station ? station.name : "SomaFM radio"}</span>
    </div>
  );
}