/**
 * SomaFM radio — chill-mood background music in the status bar.
 *
 * Design constraints (user-mandated):
 *  - Feature is opt-in via General settings; the status-bar UI only mounts
 *    when enabled, so a disabled radio costs nothing.
 *  - EVERY operation is fail-safe: network errors, missing metadata, and
 *    even a broken <audio> element degrade to a quiet "radio unavailable"
 *    state — never an unhandled rejection, never a crash, never a blocker
 *    for app startup or shutdown.
 */

export type RadioStation = {
  /** Stable id (SomaFM channel key). */
  id: string;
  /** Display name. */
  name: string;
  /** Genre / mood descriptor for the picker. */
  genre: string;
  /** Direct Icecast stream URL (mp3). */
  streamUrl: string;
};

/**
 * Curated station registry — SomaFM's listener-supported channels.
 * Direct stream URLs (https://somafm.com/listen/*.txt) rather than the
 * channel pages, so the <audio> element gets a real Icecast stream.
 * Verify URLs occasionally — SomaFM rotates ice1/ice2/ice4 hosts.
 */
export const RADIO_STATIONS: RadioStation[] = [
  {
    id: "groovesalad",
    name: "Groove Salad",
    genre: "Ambient / downtempo",
    streamUrl: "https://ice2.somafm.com/groovesalad-128-mp3",
  },
  {
    id: "defcon",
    name: "DEF CON Radio",
    genre: "Hacker / chill",
    streamUrl: "https://ice2.somafm.com/defcon-128-mp3",
  },
  {
    id: "dronezone",
    name: "Drone Zone",
    genre: "Ambient drone",
    streamUrl: "https://ice2.somafm.com/dronezone-128-mp3",
  },
  {
    id: "spacestation",
    name: "Space Station Soma",
    genre: "Space ambient / lounge",
    streamUrl: "https://ice2.somafm.com/spacestation-128-mp3",
  },
  {
    id: "lush",
    name: "Lush",
    genre: "Vocal chill",
    streamUrl: "https://ice2.somafm.com/lush-128-mp3",
  },
  {
    id: "indiepop",
    name: "Indie Pop Rocks!",
    genre: "Indie pop",
    streamUrl: "https://ice2.somafm.com/indiepop-128-mp3",
  },
  {
    id: "secretagent",
    name: "Secret Agent",
    genre: "Lounge / spy jazz",
    streamUrl: "https://ice2.somafm.com/secretagent-128-mp3",
  },
  {
    id: "fluid",
    name: "Fluid",
    genre: "Instrumental hip-hop",
    streamUrl: "https://ice2.somafm.com/fluid-128-mp3",
  },
  {
    id: "sonicuniverse",
    name: "Sonic Universe",
    genre: "Jazz / eclectic",
    streamUrl: "https://ice2.somafm.com/sonicuniverse-128-mp3",
  },
  {
    id: "bagel",
    name: "Bagel Radio",
    genre: "Indie rock",
    streamUrl: "https://ice2.somafm.com/bagel-128-mp3",
  },
  {
    id: "bootliquor",
    name: "Boot Liquor",
    genre: "Americana",
    streamUrl: "https://ice2.somafm.com/bootliquor-128-mp3",
  },
  {
    id: "thetrip",
    name: "The Trip",
    genre: "Progressive house",
    streamUrl: "https://ice2.somafm.com/thetrip-128-mp3",
  },
];

export function findStation(id: string | null | undefined): RadioStation | null {
  if (!id) return null;
  return RADIO_STATIONS.find((s) => s.id === id) ?? null;
}

/** Player states the UI can render without caring why. */
export type RadioStatus =
  | { state: "stopped" }
  | { state: "connecting"; station: RadioStation }
  | { state: "playing"; station: RadioStation }
  | { state: "error"; station: RadioStation | null; message: string };