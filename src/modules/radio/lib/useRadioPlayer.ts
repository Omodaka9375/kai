import { useCallback, useEffect, useState } from "react";
import {
  radioPlay,
  radioStop,
  radioShutdown,
  subscribeRadio,
  type RadioSnapshot,
} from "./radioControl";
import type { RadioStatus } from "./stations";

/**
 * React binding over the module-level radio controller (radioControl.ts).
 * The controller owns the <audio> element + state so the agent tools and
 * the status-bar widget drive ONE player. This hook just subscribes and
 * re-exposes play/stop. Everything stays fail-safe (see radioControl).
 */

export type UseRadioPlayer = {
  status: RadioStatus;
  stationId: string | null;
  playing: boolean;
  play: (id: string) => void;
  stop: () => void;
};

export function useRadioPlayer(): UseRadioPlayer {
  const [snap, setSnap] = useState<RadioSnapshot>(() => ({
    status: { state: "stopped" },
    stationId: null,
  }));

  useEffect(() => {
    const unsub = subscribeRadio(setSnap);
    return () => {
      unsub();
    };
  }, []);

  // NOTE: no auto-resume on mount — starting the app must never blast
  // audio. Playback begins ONLY on an explicit user action (station pick,
  // pill click) or the agent tools. The persisted station id is a selection,
  // restored by the widget, not a playback state.

  // App close: pause. Wrapped (embedded contexts may lack the API).
  useEffect(() => {
    const onBeforeUnload = () => radioShutdown();
    try {
      window.addEventListener("beforeunload", onBeforeUnload);
    } catch {
      // ignore
    }
    return () => {
      try {
        window.removeEventListener("beforeunload", onBeforeUnload);
      } catch {
        // ignore
      }
    };
  }, []);

  const play = useCallback((id: string) => {
    radioPlay(id);
  }, []);

  const stop = useCallback(() => {
    radioStop();
  }, []);

  const playing =
    snap.status.state === "playing" || snap.status.state === "connecting";

  return { status: snap.status, stationId: snap.stationId, playing, play, stop };
}