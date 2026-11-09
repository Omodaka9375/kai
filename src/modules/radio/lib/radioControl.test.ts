import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { RadioSnapshot } from "./radioControl";

// The controller touches window.Audio lazily — stub it before import.
class FakeAudio {
  src = "";
  preload = "";
  crossOrigin = "";
  listeners: Record<string, Array<() => void>> = {};
  paused = true;
  addEventListener(t: string, cb: () => void) {
    (this.listeners[t] ??= []).push(cb);
  }
  removeEventListener(t: string, cb: () => void) {
    this.listeners[t] = (this.listeners[t] ?? []).filter((c) => c !== cb);
  }
  load() {}
  removeAttribute() {}
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}

vi.stubGlobal("window", { Audio: FakeAudio });

const { radioPlay, radioStop, getRadioSnapshot, subscribeRadio } = await import(
  "./radioControl"
);

describe("radioControl — fail-safe contract", () => {
  const subs: Array<() => void> = [];
  beforeEach(() => {
    const unsub = subscribeRadio(() => {});
    subs.push(unsub);
  });
  afterEach(() => {
    radioStop();
    for (const u of subs.splice(0)) u();
  });

  it("unknown station → error snapshot, never a throw", () => {
    const snap = radioPlay("definitely-not-a-station");
    expect(snap.status.state).toBe("error");
    expect(getRadioSnapshot().status.state).toBe("error");
  });

  it("resolves ids, names, and genres case-insensitively", () => {
    radioPlay("groovesalad");
    expect(getRadioSnapshot().status.state).not.toBe("error");
    radioPlay("Groove Salad");
    expect(getRadioSnapshot().status.state).toBe("connecting");
    radioPlay("ambient");
    expect(getRadioSnapshot().status.state).toBe("connecting");
  });

  it("stop returns to a clean stopped snapshot", () => {
    radioPlay("dronezone");
    radioStop();
    const snap = getRadioSnapshot();
    expect(snap.status.state).toBe("stopped");
    expect(snap.stationId).toBeNull();
  });

  it("subscribers receive snapshot updates and unsubscribe cleanly", () => {
    const seen: string[] = [];
    const unsub = subscribeRadio((s) => seen.push(s.status.state));
    radioPlay("lush");
    radioStop();
    unsub();
    radioPlay("lush"); // no further updates after unsub
    expect(seen).toContain("connecting");
    expect(seen).toContain("stopped");
    expect(seen.filter((x) => x === "connecting").length).toBeGreaterThanOrEqual(1);
  });

  it("a subscriber added AFTER playback started replays the current snapshot", () => {
    // 2026-11-09 report: "when I switch projects it disappears ... shows as
    // not playing on other project while playing". The player is GLOBAL but
    // each project workspace mounts its own RadioMarquee; one mounted after
    // playback began missed the only "playing" publish and showed stopped
    // forever. subscribeRadio must deliver the CURRENT state on subscribe.
    radioPlay("lush");
    expect(getRadioSnapshot().status.state).toBe("connecting");
    const seen: RadioSnapshot[] = [];
    const unsub = subscribeRadio((s) => seen.push(s));
    // Synchronous replay, before any new publish.
    expect(seen).toHaveLength(1);
    expect(seen[0].status.state).toBe("connecting");
    unsub();
    radioStop();
  });

  it("a throwing subscriber does not break publication", () => {
    let broke = false;
    subscribeRadio(() => {
      broke = true;
      throw new Error("bad subscriber");
    });
    expect(() => radioPlay("bagel")).not.toThrow();
    expect(broke).toBe(true);
    expect(getRadioSnapshot().status.state).toBe("connecting");
  });
});

describe("useRadioPlayer — global-player, per-project-subscriber contract", () => {
  // Source pin: the hook must seed from the controller's LIVE snapshot (and
  // the controller must replay on subscribe — pinned above). A hardcoded
  // stopped seed is exactly the "shows as not playing while playing" bug.
  it("seeds its initial state from the live controller snapshot", () => {
    const src = readFileSync(
      new URL("./useRadioPlayer.ts", import.meta.url),
      "utf8",
    );
    expect(src).toContain("getRadioSnapshot");
    expect(src).not.toContain('state: "stopped"');
  });
});