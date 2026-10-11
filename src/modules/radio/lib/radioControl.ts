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
import { invoke } from "@tauri-apps/api/core";

export type RadioSnapshot = {
  status: RadioStatus;
  stationId: string | null;
};

let sharedAudio: HTMLAudioElement | null = null;
let snapshot: RadioSnapshot = { status: { state: "stopped" }, stationId: null };
let stationIdRef: string | null = null;

/** Fresh sessions start at a comfortable level — 100% is blaringly loud. */
const DEFAULT_VOLUME = 0.4;

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
    return typeof v === "number" && Number.isFinite(v) ? v : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME;
  }
}

function getAudioEl(): HTMLAudioElement | null {
  if (typeof window === "undefined") return null; // tests / SSR
  if (!sharedAudio) {
    try {
      sharedAudio = new window.Audio();
      sharedAudio.preload = "none";
      sharedAudio.volume = DEFAULT_VOLUME;
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
      // One-shot diagnostics: they localize a synchronous load refusal
      // (code 4 NotSupported) into network vs codec vs CSP.
      if (!(sharedAudio as unknown as { __diag?: boolean })?.__diag) {
        try {
          (sharedAudio as unknown as { __diag?: boolean }).__diag = true;
          const el = sharedAudio;
          if (!el) return;
          console.warn(
            "[radio] diag —",
            "canPlayType(mpeg):", el.canPlayType("audio/mpeg"),
            "| networkState:", el.networkState,
            "| currentSrc:", el.currentSrc || "(empty)",
            "| cspMeta:",
            document
              .querySelector('meta[http-equiv="Content-Security-Policy"]')
              ?.getAttribute("content") ?? "(none in document)",
          );
          // Opaque no-cors fetch: resolves if the network path to SomaFM
                   // works from the webview at all (readable CORS not needed).
          fetch(el.currentSrc || "https://ice2.somafm.com/groovesalad-128-mp3", {
            mode: "no-cors",
          })
            .then(() => console.warn("[radio] diag — no-cors fetch: OK (network reachable)"))
            .catch((e) => console.warn("[radio] diag — no-cors fetch FAILED:", String(e)));
          // ── diag v2: decoder vs network discrimination ─────────────────
          // Probe A: mp3 from a data URL — NO network involved. If this
          // fails, the WebView's media/decoder stack itself is broken
          // (canPlayType consults the registry and can lie). Probe B: a
          // remote STATIC https mp3 — isolates live-stream (icecast/
          // chunked, no content-length) from ordinary https media.
          const probe = (label: string, src: string) => {
            const a = new window.Audio();
            a.preload = "auto";
            a.src = src;
            const done = (ok: boolean, detail: string) =>
              console.warn(`[radio] diag2 ${label}: ${ok ? "PLAYABLE" : "FAIL"} ${detail}`);
            a.addEventListener("canplay", () => {
              done(true, "");
              try { a.pause(); } catch { /* ignore */ }
            }, { once: true });
            a.addEventListener("error", () => {
              done(false, `(error code ${a.error?.code} ${a.error?.message ?? ""})`);
            }, { once: true });
            try {
              const p = a.play();
              p?.then(() => done(true, "(play resolved)")).catch((err: unknown) =>
                done(false, `(play rejected: ${err instanceof Error ? err.name + ": " + err.message : String(err)})`));
            } catch (err) {
              done(false, `(play threw: ${String(err)})`);
            }
          };
          const DATA_MP3 =
            "data:audio/mpeg;base64,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";
          probe("A:decoder(data-URL mp3)", DATA_MP3);
          probe("B:https-static-mp3", "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3");
          probe("C:icecast-stream", el.currentSrc);
        } catch {
          // diagnostics must never break the error path
        }
      }
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
  void radioPlayAsync(id);
  return snapshot;
}

/**
 * Async play path. Prefers the Rust-side stream proxy (radio_proxy_start)
 * when under Tauri: WebView2's media loader refuses live Icecast responses
 * (HTTP/1.0 + no content-length + 200-for-Range), so we re-serve the stream
 * locally as well-formed chunked HTTP/1.1. Falls back to the direct URL
 * when the proxy is unavailable (tests, plain web).
 */
async function radioPlayAsync(id: string): Promise<void> {
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
    return;
  }
  const el = getAudioEl();
  if (!el) {
    publish({
      status: { state: "error", station, message: "Audio unavailable." },
      stationId: station.id,
    });
    return;
  }
  stationIdRef = station.id;
  publish({
    status: { state: "connecting", station },
    stationId: station.id,
  });
  let src = station.streamUrl;
  try {
    const port = await invoke<number>("radio_proxy_start", {
      url: station.streamUrl,
    });
    if (typeof port === "number" && port > 0) {
      src = `http://127.0.0.1:${port}/stream`;
    }
  } catch (e) {
    // Proxy unavailable (tests / plain web) — direct stream it is.
    console.warn("[radio] proxy unavailable, playing direct:", String(e));
  }
  if (stationIdRef !== station.id) return; // switched/stopped mid-await
  try {
    el.src = src;
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
}

/** Stop playback and tear down the stream connection. Fail-safe. */
export function radioStop(): RadioSnapshot {
  stationIdRef = null;
  // Tear down the Rust-side proxy too (kills the upstream connection).
  try {
    void invoke("radio_proxy_stop");
  } catch {
    // not under Tauri — fine
  }
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