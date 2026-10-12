import { describe, expect, it } from "vitest";
import {
  SHORTCUTS,
  collidesWithTerminal,
  getBindingTokens,
  matchBinding,
  type KeyBinding,
} from "./shortcuts";

// Minimal KeyboardEvent stand-in — matchBinding only reads the modifier flags
// and `key`, so a plain object cast is enough (and avoids jsdom).
const ev = (init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent =>
  ({
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...init,
  }) as KeyboardEvent;

describe("matchBinding", () => {
  it("matches an exact chord", () => {
    expect(
      matchBinding(ev({ key: "k", ctrlKey: true }), { ctrl: true, key: "k" }),
    ).toBe(true);
  });

  it("is case-insensitive on the key", () => {
    expect(
      matchBinding(ev({ key: "K", ctrlKey: true }), { ctrl: true, key: "k" }),
    ).toBe(true);
  });

  it("rejects a wrong key", () => {
    expect(
      matchBinding(ev({ key: "j", ctrlKey: true }), { ctrl: true, key: "k" }),
    ).toBe(false);
  });

  it("requires the modifier set exactly — a missing modifier fails", () => {
    expect(matchBinding(ev({ key: "s" }), { ctrl: true, key: "s" })).toBe(false);
  });

  it("requires the modifier set exactly — an extra modifier fails", () => {
    expect(
      matchBinding(ev({ key: "s", ctrlKey: true, shiftKey: true }), {
        ctrl: true,
        key: "s",
      }),
    ).toBe(false);
  });

  it("distinguishes shift", () => {
    expect(
      matchBinding(ev({ key: "d", ctrlKey: true, shiftKey: true }), {
        ctrl: true,
        shift: true,
        key: "d",
      }),
    ).toBe(true);
  });

  it("tab.selectByIndex matches any digit 1-9 regardless of the stored key", () => {
    const b: KeyBinding = { ctrl: true, key: "1" };
    expect(matchBinding(ev({ key: "7", ctrlKey: true }), b, "tab.selectByIndex")).toBe(
      true,
    );
    expect(matchBinding(ev({ key: "0", ctrlKey: true }), b, "tab.selectByIndex")).toBe(
      false,
    );
  });
});

// In the Node test env `platform()` throws → IS_MAC is false → the primary
// modifier is Ctrl, i.e. the Windows/Linux behaviour under test.
describe("collidesWithTerminal (non-macOS)", () => {
  it("flags a bare primary-mod chord (shell readline key)", () => {
    expect(collidesWithTerminal({ ctrl: true, key: "r" })).toBe(true);
    expect(collidesWithTerminal({ ctrl: true, key: "d" })).toBe(true);
  });

  it("does not flag chords that add shift/alt/meta", () => {
    expect(collidesWithTerminal({ ctrl: true, shift: true, key: "d" })).toBe(false);
    expect(collidesWithTerminal({ ctrl: true, alt: true, key: "d" })).toBe(false);
    expect(collidesWithTerminal({ ctrl: true, meta: true, key: "d" })).toBe(false);
  });

  it("does not flag modifier-less chords", () => {
    expect(collidesWithTerminal({ shift: true, key: "Enter" })).toBe(false);
    expect(collidesWithTerminal({ key: "Enter" })).toBe(false);
  });
});

describe("registry integrity", () => {
  it("has unique shortcut ids", () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has no duplicate default bindings across shortcuts", () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const s of SHORTCUTS) {
      for (const b of s.defaultBindings) {
        const sig = [
          b.ctrl && "ctrl",
          b.shift && "shift",
          b.alt && "alt",
          b.meta && "meta",
          b.key.toLowerCase(),
        ]
          .filter(Boolean)
          .join("+");
        const prior = seen.get(sig);
        if (prior) dupes.push(`${sig} (${prior} & ${s.id})`);
        else seen.set(sig, s.id);
      }
    }
    expect(dupes).toEqual([]);
  });

  it("every shortcut ships at least one default binding", () => {
    for (const s of SHORTCUTS) {
      expect(s.defaultBindings.length).toBeGreaterThan(0);
    }
  });
});

describe("getBindingTokens", () => {
  it("returns an empty list for no binding", () => {
    expect(getBindingTokens(undefined)).toEqual([]);
  });

  it("renders a modifier-less chord", () => {
    expect(getBindingTokens({ shift: true, key: "Enter" })).toContain("Enter");
  });
});
