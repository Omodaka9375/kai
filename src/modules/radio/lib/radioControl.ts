/**
 * Module-level radio controller — the imperative play/stop/state API behind
 * both the status-bar React hook and the agent tools. One shared <audio>
 * element, created lazily; one state snapshot; a tiny subscriber set.
 *
 * Fail-safe contract (same as the hook): every operation degrades to a
 * quiet error status. Nothing here ever throws to its caller.
 */

import {
  RADIO_STATIONS,
  findStation,
  type RadioStatus,
} from "./stations";

export type RadioSnapshot = {
  status: RadioStatus;
  stationId: string | null;
};

let sharedAudio: HTMLAudioElement | null = null;
let snapshot: RadioSnapshot = { status: { state: "stopped" }, stationId: null };
let stationIdRef: string | null = null;

const listeners = new Set<(s: RadioSnapshot) => void>();

function publish(next: RadioSnapshot) {
  snapshot = next;
  for (const l of listeners) {
    try {
      l(next);
    } catch {
      // A broken subscriber must not break playback for everyone else.
    }
  }
}

export function subscribeRadio(cb: (s: RadioSnapshot) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getRadioSnapshot(): RadioSnapshot {
  return snapshot;
}

/** Mute/unmute the shared element. Fail-safe: never throws. */
export function radioSetMuted(muted: boolean): void {
  const el = sharedAudio;
  if (!el) return;
  try {
    el.muted = muted;
  } catch {
    // ignore — broken element must not throw to callers
  }
}

export function radioGetMuted(): boolean {
  try {
    return sharedAudio?.muted ?? false;
  } catch {
    return false;
  }
}

/** Set volume 0..1 on the shared element. Fail-safe: never throws. */
export function radioSetVolume(v: number): void {
  const el = sharedAudio;
  if (!el) return;
  try {
    el.volume = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 1));
  } catch {
    // ignore
  }
}

export function radioGetVolume(): number {
  try {
    const v = sharedAudio?.volume;
    return typeof v === "number" && Number.isFinite(v) ? v : 1;
  } catch {
    return 1;
  }
}

function getAudioEl(): HTMLAudioElement | null {
  if (typeof window === "undefined") return null; // tests / SSR
  if (!sharedAudio) {
    try {
      sharedAudio = new window.Audio();
      sharedAudio.preload = "none";
      // NOTE: no crossOrigin. SomaFM's Icecast sends no CORS headers, and a
      // crossOrigin="anonymous" <audio> element makes every stream request
      // a CORS request → instant MEDIA_ERR on EVERY station (the "all streams
      // fail" bug). Plain media requests need no CORS. Nothing reads pixels
      // from this element, so there is nothing to taint anyway.
    } catch {
      return null;
    }
    // Element-level events → snapshot updates. Wrapped: a broken element
    // in some embedded engine must not throw from an event handler.
    const toError = () => {
      const station = findStation(stationIdRef);
      const mediaErr = (sharedAudio as HTMLAudioElement | null)?.error;
      console.warn("[radio] element error event:", mediaErr?.code, mediaErr?.message);
      const why =
        mediaErr?.code === 2
          ? "network error — SomaFM may be blocked or offline"
          : mediaErr?.code === 4
            ? "stream format/decode error"
            : "stream failed";
      publish({
        status: {
          state: "error",
          station,
          message: `${why} — try another station.`,
        },
        stationId: stationIdRef,
      });
    };
    const toPlaying = () => {
      const station = findStation(stationIdRef);
      if (station) {
        publish({
          status: { state: "playing", station },
          stationId: stationIdRef,
        });
      }
    };
    try {
      sharedAudio.addEventListener("error", toError);
      sharedAudio.addEventListener("playing", toPlaying);
    } catch {
      // ignore
    }
  }
  return sharedAudio;
}

/** Play a station by id (or name, matched case-insensitively). Fail-safe. */
export function radioPlay(id: string): RadioSnapshot {
  const station = findStation(id) ?? fuzzyStation(id);
  if (!station) {
    publish({
      status: {
        state: "error",
        station: null,
        message: `Unknown station "${id}" — see station list.`,
      },
      stationId: stationIdRef,
    });
    return snapshot;
  }
  const el = getAudioEl();
  if (!el) {
    publish({
      status: { state: "error", station, message: "Audio unavailable." },
      stationId: station.id,
    });
    return snapshot;
  }
  stationIdRef = station.id;
  publish({
    status: { state: "connecting", station },
    stationId: station.id,
  });
  try {
    el.src = station.streamUrl;
    el.load();
    const p = el.play();
    if (p && typeof p.then === "function") {
      p.then(() => {
        if (stationIdRef === station.id) {
          publish({
            status: { state: "playing", station },
            stationId: station.id,
          });
        }
      }).catch((err: unknown) => {
        console.warn("[radio] play() rejected:", err);
        if (stationIdRef === station.id) {
          const name =
            err instanceof Error ? `${err.name}: ${err.message}` : String(err);
          publish({
            status: {
              state: "error",
              station,
              message: `Playback rejected (${name})`,
            },
            stationId: station.id,
          });
        }
      });
    }
  } catch (err) {
    console.warn("[radio] play() sync error:", err);
    publish({
      status: {
        state: "error",
        station,
        message: `Playback error (${String(err)})`,
      },
      stationId: station.id,
    });
  }
  return snapshot;
}

/** Stop playback and tear down the stream connection. Fail-safe. */
export function radioStop(): RadioSnapshot {
  stationIdRef = null;
  const el = sharedAudio;
  if (el) {
    try {
      el.pause();
      el.removeAttribute("src");
      el.load();
    } catch {
      // cleanup must never throw (also runs on unmount paths)
    }
  }
  publish({ status: { state: "stopped" }, stationId: null });
  return snapshot;
}

/** Pause on app close — beforeunload path, wrapped. */
export function radioShutdown(): void {
  try {
    sharedAudio?.pause();
  } catch {
    // ignore
  }
}

/** Case-insensitive name/id/genre match so "groove salad" or "ambient" resolve. */
function fuzzyStation(query: string): ReturnType<typeof findStation> {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  for (const s of RADIO_STATIONS) {
    if (
      s.name.toLowerCase() === q ||
      s.id.toLowerCase() === q ||
      s.name.toLowerCase().includes(q) ||
      q.includes(s.id.toLowerCase()) ||
      s.genre.toLowerCase().includes(q)
    ) {
      return s;
    }
  }
  return null;
}