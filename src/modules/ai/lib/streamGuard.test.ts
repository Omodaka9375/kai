/**
 * Tests for Stream Guard - Loop Detection
 */

import { describe, it, expect } from "vitest";
import {
  StreamGuard,
  getGlobalStreamGuard,
  resetGlobalStreamGuard,
  toolLoopFingerprint,
} from "./streamGuard";

describe("toolLoopFingerprint — output-aware repeat detection", () => {
  const step = (
    input: unknown,
    output: unknown,
  ): Parameters<typeof toolLoopFingerprint>[0] => ({
    toolCalls: [{ toolName: "bash_logs", input }],
    toolResults: [{ toolName: "bash_logs", output }],
  });

  it("returns null with no tool calls (resets the counter)", () => {
    expect(toolLoopFingerprint({ toolCalls: [] })).toBeNull();
    expect(toolLoopFingerprint({})).toBeNull();
  });

  it("SAME args but NEW output is NOT a repeat (progress, not a loop)", () => {
    // This is the false positive that killed healthy log-tailing runs.
    const a = toolLoopFingerprint(step({ handle: 1 }, "build step 1 done"))!;
    const b = toolLoopFingerprint(step({ handle: 1 }, "build step 2 done"))!;
    const c = toolLoopFingerprint(step({ handle: 1 }, "build step 3 done"))!;
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
  });

  it("SAME args AND identical output IS a repeat (a real loop)", () => {
    const a = toolLoopFingerprint(step({ handle: 1 }, "unchanged"))!;
    const b = toolLoopFingerprint(step({ handle: 1 }, "unchanged"))!;
    expect(a).toBe(b);
  });

  it("different args are a different fingerprint", () => {
    const a = toolLoopFingerprint(step({ handle: 1 }, "x"))!;
    const b = toolLoopFingerprint(step({ handle: 2 }, "x"))!;
    expect(a).not.toBe(b);
  });

  it("is order-insensitive within a step", () => {
    const s1 = {
      toolCalls: [
        { toolName: "a", input: { n: 1 } },
        { toolName: "b", input: { n: 2 } },
      ],
      toolResults: [
        { toolName: "a", output: "ra" },
        { toolName: "b", output: "rb" },
      ],
    };
    const s2 = {
      toolCalls: [
        { toolName: "b", input: { n: 2 } },
        { toolName: "a", input: { n: 1 } },
      ],
      toolResults: [
        { toolName: "b", output: "rb" },
        { toolName: "a", output: "ra" },
      ],
    };
    expect(toolLoopFingerprint(s1)).toBe(toolLoopFingerprint(s2));
  });
});

describe("StreamGuard", () => {
  describe("basic functionality", () => {
    it("should not detect loop with fewer than 3 outputs", () => {
      const guard = new StreamGuard();
      
      const result1 = guard.check("output 1");
      const result2 = guard.check("output 2");
      
      expect(result1.isLooping).toBe(false);
      expect(result2.isLooping).toBe(false);
    });

    it("should detect repeated identical outputs", () => {
      const guard = new StreamGuard({ windowSize: 5, similarityThreshold: 0.85 });
      
      const output = "I need to read the file first to understand the codebase structure";
      
      // Feed the same output multiple times
      guard.check(output);
      guard.check(output);
      const result3 = guard.check(output);
      const result4 = guard.check(output);
      
      expect(result3.isLooping).toBe(true);
      expect(result3.confidence).toBeGreaterThan(0.8);
      expect(result4.isLooping).toBe(true);
      expect(result4.suggestion).toBeTruthy();
    });

    it("should detect alternating patterns", () => {
      const guard = new StreamGuard({ windowSize: 5, similarityThreshold: 0.85 });
      
      const outputA = "I'll read the configuration file first";
      const outputB = "Now let me check the package.json for dependencies";
      
      // Create alternating pattern: A, B, A, B
      guard.check(outputA);
      guard.check(outputB);
      guard.check(outputA);
      const result = guard.check(outputB);
      
      expect(result.isLooping).toBe(true);
      expect(result.detectedPattern).toContain("Alternating");
    });

    it("should reset state correctly", () => {
      const guard = new StreamGuard();
      
      // Create a loop
      guard.check("same output");
      guard.check("same output");
      guard.check("same output");
      
      const beforeReset = guard.check("same output");
      expect(beforeReset.isLooping).toBe(true);
      
      // Reset
      guard.reset();
      
      const afterReset = guard.check("new output");
      expect(afterReset.isLooping).toBe(false);
    });
  });

  describe("similarity calculation", () => {
    // NOTE (2026-10-31 fix): similarity is bigram-shingle Jaccard. The old
    // word-set metric had a multiset bug (intersection counted duplicates,
    // union deduped) that pushed scores ABOVE 1.0 on noun-heavy reasoning
    // and over-fired the loop kill on healthy same-topic thinking. Toy-size
    // strings where a single word differs by form ("configuration" vs
    // "config") legitimately score ~0.5 now; production gates feed the
    // guard only 300+-char step text, where one swapped word is ~2 shingles
    // out of dozens and near-duplicates stay >0.9.
    it("should detect high similarity for near-identical long content", () => {
      const guard = new StreamGuard({ windowSize: 5, similarityThreshold: 0.7 });

      const output1 =
        "I need to read the failing test first to understand what the expected behavior is, then read the implementation module that the test imports so I can see where the returned value diverges from the assertion, and after that make the smallest possible change that satisfies the test before running the full suite again.";
      // output2 differs by ONE word ("configuration" -> "setup").
      const output2 = output1.replace("the test imports", "the test consumes");
      const output3 = output1;

      guard.check(output1);
      guard.check(output2);
      const result = guard.check(output3);

      expect(result.isLooping).toBe(true);
    });

    it("similarity is bounded to [0,1] even for heavily repeated vocabulary", () => {
      // The old multiset-intersection bug measured >1.0 on exactly this
      // shape (domain nouns repeated per occurrence). True set-Jaccard on
      // shingles can never exceed 1.
      const guard = new StreamGuard({
        windowSize: 5,
        similarityThreshold: 0.99,
      });
      const a =
        "check the terminal output, then check the terminal output again, because the terminal output shows the build result and the terminal output must be checked";
      const b =
        "check the terminal output and then check the terminal output again, because the terminal output shows the build result and the terminal output must be checked";
      // Drive two private-similarity invocations through the public path.
      guard.check(a);
      guard.check(b);
      // No throw, no NaN, and a third identical text still fires at 0.99 —
      // meaning a === a scored exactly 1.0, not >1.
      const r = guard.check(a);
      expect(r.isLooping).toBe(true);
      expect(r.confidence).toBeLessThanOrEqual(1);
    });

    it("paraphrased same-topic reasoning does NOT fire (the over-firing regression)", () => {
      // Real-world shape from the report: a thinking model iterating over
      // one problem reuses most of its vocabulary but changes order and
      // conclusions. Word-set Jaccard scored these >=0.9 (and >1.0 with
      // duplicates); shingles keep them far below threshold.
      const guard = new StreamGuard({ windowSize: 5, similarityThreshold: 0.85 });
      const r1 =
        "The test failure is in the parser module. Looking at the stack trace, the error happens when the tokenizer receives an empty string. I should check the guard clause at the top of the function and see whether the caller can pass an empty value in production. The most likely cause is the config loader stripping quotes before the parser runs.";
      const r2 =
        "Looking deeper at the failing test, the error is thrown from the tokenizer when it receives an empty input string. Before the parser runs, the config loader may strip quotes and produce an empty value. I will add a guard clause at the top of the function and check whether the caller can pass an empty string in production.";
      const r3 =
        "I think the root cause is confirmed: the config loader strips quotes before the tokenizer sees its input, so the parser receives an empty string in production. A guard clause at the top of the function should handle this. Let me write the fix and check the failing test again after the change.";
      guard.check(r1);
      guard.check(r2);
      const result = guard.check(r3);
      expect(result.isLooping).toBe(false);
    });

    it("should not detect loop for different content", () => {
      const guard = new StreamGuard({ windowSize: 5, similarityThreshold: 0.85 });
      
      guard.check("Read the package.json file");
      guard.check("Now let me check the tsconfig.json");
      guard.check("Let me look at the src directory structure");
      
      const result = guard.check("I'll examine the README.md for documentation");
      
      expect(result.isLooping).toBe(false);
    });
  });

  describe("tool call pattern detection", () => {
    it("should detect repeated tool calls", () => {
      const guard = new StreamGuard({ windowSize: 5, similarityThreshold: 0.85 });
      
      guard.check("tool-call: read_file - Reading package.json");
      guard.check("tool-call: read_file - Reading tsconfig.json");
      guard.check("tool-call: read_file - Reading config.json");
      const result = guard.check("tool-call: read_file - Reading vite.config.ts");
      
      expect(result.isLooping).toBe(true);
      expect(result.detectedPattern).toContain("read_file");
    });
  });

  describe("global instance", () => {
    it("should return the same instance", () => {
      const instance1 = getGlobalStreamGuard();
      const instance2 = getGlobalStreamGuard();
      
      expect(instance1).toBe(instance2);
    });

    it("should reset global instance", () => {
      const guard = getGlobalStreamGuard();
      guard.check("test");
      
      resetGlobalStreamGuard();
      
      const newGuard = getGlobalStreamGuard();
      expect(newGuard).not.toBe(guard);
    });
  });
});
