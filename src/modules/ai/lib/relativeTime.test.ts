import { describe, expect, it } from "vitest";
import { absoluteTime, relativeTime } from "./relativeTime";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const T = (iso: string) => Date.parse(iso);

describe("relativeTime", () => {
  it("returns empty string for invalid timestamps", () => {
    expect(relativeTime(null, NOW)).toBe("");
    expect(relativeTime(undefined, NOW)).toBe("");
    expect(relativeTime(0, NOW)).toBe("");
    expect(relativeTime(Number.NaN, NOW)).toBe("");
  });

  it("under one minute → just now", () => {
    expect(relativeTime(T("2026-10-11T11:59:30Z"), NOW)).toBe("just now");
  });

  it("minutes and hours → compact suffixes", () => {
    expect(relativeTime(T("2026-10-11T11:55:00Z"), NOW)).toBe("5m ago");
    expect(relativeTime(T("2026-10-11T09:00:00Z"), NOW)).toBe("3h ago");
  });

  it("around a day → yesterday / days ago", () => {
    expect(relativeTime(T("2026-10-10T12:00:00Z"), NOW)).toBe("yesterday");
    // 3 days back (same year boundary not relevant here)
    expect(relativeTime(T("2026-10-08T12:00:00Z"), NOW)).toBe("3d ago");
  });

  it("a week or older → absolute month-day, year only if different calendar year", () => {
    // 8 days back, same year
    const s = relativeTime(T("2026-10-03T12:00:00Z"), NOW);
    expect(s).not.toContain("ago");
    expect(s.startsWith("Oct")).toBe(true);
    // different year → appended year
    const old = relativeTime(T("2025-12-30T12:00:00Z"), NOW);
    expect(old).toContain("2025");
  });

  it("future timestamps degrade gracefully (clock skew)", () => {
    // 30s ahead — treated as 'just now' rather than negative durations.
    expect(relativeTime(NOW + 30_000, NOW)).toBe("just now");
  });
});

describe("absoluteTime", () => {
  it("formats full local date+time, empty on invalid", () => {
    expect(absoluteTime(null)).toBe("");
    expect(absoluteTime(0)).toBe("");
    const out = absoluteTime(NOW);
    expect(out).toMatch(/2026/);
    expect(out.length).toBeGreaterThan(10);
  });
});