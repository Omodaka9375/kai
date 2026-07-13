/**
 * Tests for Stream Guard - Loop Detection
 */

import { describe, it, expect } from "vitest";
import { StreamGuard, getGlobalStreamGuard, resetGlobalStreamGuard } from "./streamGuard";

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
    it("should detect high similarity for similar content", () => {
      const guard = new StreamGuard({ windowSize: 5, similarityThreshold: 0.7 });
      
      const output1 = "I need to read the configuration file to understand the project structure";
      const output2 = "I need to read the config file to understand the project structure";
      const output3 = "I need to read the configuration file to understand the project structure";
      
      guard.check(output1);
      guard.check(output2);
      const result = guard.check(output3);
      
      expect(result.isLooping).toBe(true);
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
