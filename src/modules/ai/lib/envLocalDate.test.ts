import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { envLocalDate } from "./transport";

// The agent env block is the ONLY time source a KAI agent has — LLMs have
// no clock and otherwise answer "what day is it" from a stale training
// cutoff. These tests pin the format (ISO, unambiguous) and the injection
// contract (the <env> builder actually includes the field, the system
// prompt actually explains it).

describe("envLocalDate", () => {
  it("renders ISO date + weekday + UTC offset for a known local date", () => {
    // Constructed from LOCAL components → the date and weekday are
    // zone-independent by construction (both derive from the same wall
    // fields). 2026-01-05 is a Monday.
    const s = envLocalDate(new Date(2026, 0, 5, 12, 0, 0));
    expect(s).toMatch(/^2026-01-05 \(Mon, UTC[+-]\d{2}:\d{2}/);
  });

  it("never emits a locale-ambiguous numeric date", () => {
    // The whole point is killing 10/24-vs-24/10 confusion across locales.
    const s = envLocalDate();
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it("pads single-digit months/days (lexical sort == chronological)", () => {
    const s = envLocalDate(new Date(2026, 8, 6)); // Sep 6
    expect(s.startsWith("2026-09-06 ")).toBe(true);
  });
});

describe("env-block injection contract", () => {
  const src = readFileSync(new URL("./transport.ts", import.meta.url), "utf8");

  it("formatEnvBlockInner pushes a local_date line", () => {
    expect(src).toContain("local_date: ${envLocalDate()}");
  });

  it("the system prompt documents local_date for the model", () => {
    const prompt = readFileSync(
      new URL("../config/prompt.ts", import.meta.url),
      "utf8",
    );
    expect(prompt).toContain("local_date");
    // It must be described as authoritative, or the model keeps guessing.
    expect(prompt).toMatch(/local_date is the authoritative current date/);
  });
});