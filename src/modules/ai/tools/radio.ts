/**
 * Radio tools — let the agent set the mood: pick a station and play, stop,
 * or list what's available. The radio is a UI feature; these tools drive the
 * SAME player instance as the status-bar widget (radioControl.ts).
 *
 * Contract: the radio must NEVER block or error the agent flow. Every
 * execute() returns a status snapshot; nothing throws.
 */

import { tool } from "ai";
import { z } from "zod";
import {
  getRadioSnapshot,
  radioPlay,
  radioStop,
} from "@/modules/radio/lib/radioControl";
import { RADIO_STATIONS, findStation } from "@/modules/radio/lib/stations";
import { getRadioEnabled, setRadioStationId } from "@/modules/radio/radioPrefs";
import { type ToolContext } from "./context";

function describeSnapshot() {
  const snap = getRadioSnapshot();
  const s = snap.status;
  switch (s.state) {
    case "stopped":
      return { state: "stopped" as const };
    case "connecting":
      return {
        state: "connecting" as const,
        station: s.station?.name ?? null,
      };
    case "playing":
      return { state: "playing" as const, station: s.station.name };
    case "error":
      return {
        state: "error" as const,
        station: s.station?.name ?? null,
        message: s.message,
      };
  }
}

export function buildRadioTools(_ctx: ToolContext) {
  return {
    radio_list_stations: tool({
      description:
        "List the available SomaFM radio stations (id, name, genre). Use this when the user wants music/a mood but you're not sure which station fits, or when a requested station isn't found.",
      inputSchema: z.object({}),
      execute: async () => ({
        stations: RADIO_STATIONS.map((s) => ({
          id: s.id,
          name: s.name,
          genre: s.genre,
        })),
        now: describeSnapshot(),
      }),
    }),

    play_radio: tool({
      description:
        "Play a SomaFM radio station in the user's status bar — background music for a chill programming mood. The station also starts if the radio is currently stopped. Match the user's requested mood to a station genre; use radio_list_stations if unsure which fits. Never blocks anything: if the stream fails the status bar shows an unavailable state.",
      inputSchema: z.object({
        station: z
          .string()
          .describe(
            "Station id, name, or genre — e.g. 'groovesalad', 'Groove Salad', or 'ambient'. Matched case-insensitively.",
          ),
      }),
      execute: async ({ station }) => {
        // The radio is an opt-in UI feature — enabling it on first agent
        // use matches user intent ("play me something"), and if it fails
        // nothing errors.
        try {
          const enabled = await getRadioEnabled();
          if (!enabled) {
            const { setRadioEnabled } = await import(
              "@/modules/radio/radioPrefs"
            );
            await setRadioEnabled(true);
          }
        } catch {
          // prefs unreachable — play anyway; the audio path is independent.
        }
        const resolved =
          findStation(station) ??
          RADIO_STATIONS.find((s) => s.name.toLowerCase() === station.toLowerCase()) ??
          RADIO_STATIONS.find(
            (s) =>
              s.id.toLowerCase() === station.toLowerCase() ||
              s.name.toLowerCase().includes(station.toLowerCase()) ||
              s.genre.toLowerCase().includes(station.toLowerCase()),
          ) ??
          null;
        if (!resolved) {
          return {
            error: `No station matching "${station}" — call radio_list_stations for the list.`,
            now: describeSnapshot(),
          };
        }
        radioPlay(resolved.id);
        try {
          await setRadioStationId(resolved.id);
        } catch {
          // persistence is best-effort
        }
        return {
          ok: true,
          station: resolved.name,
          genre: resolved.genre,
          note: "Stream is connecting — the status bar shows it shortly.",
          now: describeSnapshot(),
        };
      },
    }),

    stop_radio: tool({
      description:
        "Stop the radio. Use when the user asks for silence, wants to focus, or explicitly says stop the music.",
      inputSchema: z.object({}),
      execute: async () => {
        radioStop();
        try {
          await setRadioStationId("");
        } catch {
          // persistence is best-effort
        }
        return { ok: true, now: describeSnapshot() };
      },
    }),
  } as const;
}