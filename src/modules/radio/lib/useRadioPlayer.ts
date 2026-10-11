import { useCallback, useEffect, useState } from "react";
import {
  radioPlay,
  radioStop,
  radioShutdown,
  subscribeRadio,
  type RadioSnapshot,
} from "./radioControl";
import { findStation, type RadioStatus } from "./stations";

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

export function useRadioPlayer(initialStationId: string | null = null): UseRadioPlayer {
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

  // Restore persisted station once on mount — auto-resume only when the
  // feature is enabled (the widget isn't mounted otherwise). Fail-safe.
  useEffect(() => {
    let cancelled = false;
    if (initialStationId && findStation(initialStationId)) {
      // Defer so the subscriber effect above is attached first.
      const t = setTimeout(() => {
        if (!cancelled) radioPlay(initialStationId);
      }, 0);
      return () => {
        cancelled = true;
        clearTimeout(t);
      };
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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