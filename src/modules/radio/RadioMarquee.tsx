import { useEffect, useMemo, useRef, useState } from "react";
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
 *  - The pill (station name) opens the STATION PICKER (stations only).
 *  - A stop button sits inline after the pill while playing.
 *  - The speaker icon toggles MUTE directly; hovering the icon reveals a
 *    thin inline volume slider that extends to the right (no popover).
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
  // Volume slider is hidden until the group (icon + slider) is hovered or
  // the thumb is being dragged — collapsed to zero width, not display:none,
  // so the reveal can transition smoothly and the status bar never janks.
  const [volOpen, setVolOpen] = useState(false);
  const volGroupRef = useRef<HTMLDivElement | null>(null);

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
          {RADIO_STATIONS.map((s) => (
            <DropdownMenuItem
              key={s.id}
              onSelect={() => handleStationPick(s.id)}
              className={cn(
                "gap-2 py-1.5 text-xs",
                stationId === s.id && "bg-accent/40",
              )}
            >
              <HugeiconsIcon
                icon={MusicNote01Icon}
                size={11}
                strokeWidth={1.75}
                className={cn(
                  "shrink-0 self-start mt-0.5",
                  stationId === s.id && "text-emerald-500",
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{s.name}</span>
                <span className="block truncate text-[10px] leading-tight text-muted-foreground/70">
                  {s.genre}
                </span>
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Stop button — inline, only while a station is active. Replaces the
          old Stop item inside the picker (one less menu walk to stop). */}
      {active && (
        <button
          type="button"
          title="Stop playback"
          aria-label="Stop radio"
          onClick={handleStop}
          data-testid="radio-stop"
          className="shrink-0 rounded-full p-1 text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
        >
          <HugeiconsIcon icon={StopIcon} size={11} strokeWidth={2} />
        </button>
      )}
      {/* Mute toggle + volume in ONE row: the speaker icon toggles mute
          directly, and the thin inline slider reveals on hover — collapsed
          otherwise. Hover OR active drag keeps it open; the pointer has to
          leave (and the drag end) before it collapses again. */}
      <div
        ref={volGroupRef}
        className="flex shrink-0 items-center"
        onMouseEnter={() => setVolOpen(true)}
        onMouseLeave={() => setVolOpen(false)}
      >
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
        <div
          className={cn(
            "overflow-hidden transition-[width,opacity] duration-150 ease-out",
            volOpen ? "w-14 opacity-100" : "w-0 opacity-0",
          )}
        >
          <Slider
            value={[volume]}
            min={0}
            max={1}
            step={0.05}
            onValueChange={(v) => handleVolume(v[0] ?? 1)}
            onPointerDown={() => setVolOpen(true)}
            onPointerUp={() => {
              // Radix captures the pointer during a drag, which suppresses
              // mouseleave on the group. Close only when the release lands
              // OUTSIDE the group — releasing while still hovering keeps it
              // open (the hover state would otherwise be stranded closed).
              if (!volGroupRef.current?.matches(":hover")) setVolOpen(false);
            }}
            onFocus={() => setVolOpen(true)}
            onBlur={() => setVolOpen(false)}
            aria-label="Radio volume"
            className={cn(
              "w-14",
              // Thin-inline overrides of the chunky default slider: 4px track,
              // 8px thumb (the primitive ships h-2 track / h-4 w-6 thumb).
              "[&_[data-slot=slider-track]]:h-1",
              "[&_[data-slot=slider-thumb]]:size-2",
              "[&_[data-slot=slider-thumb]]:w-2",
              "[&_[data-slot=slider-thumb]]:ring-0",
              "[&_[data-slot=slider-thumb]]:shadow-none",
            )}
          />
        </div>
      </div>
      {/* Screen-reader/live region only — the visual status is in the pill. */}
      <span className="sr-only">{station ? station.name : "SomaFM radio"}</span>
    </div>
  );
}