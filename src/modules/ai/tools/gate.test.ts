/**
 * Tests for Gate Tool - Tsforge-style validation
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseGateOutput,
  detectPackageManager,
  getGateCommands,
} from "./gate";
import { native } from "../lib/native";

// Mock the native module
vi.mock("../lib/native", () => ({
  native: {
    readDir: vi.fn(),
    readFile: vi.fn(),
  },
}));

describe("parseGateOutput", () => {
  describe("TypeScript error parsing", () => {
    it("should parse TypeScript error with line and column", () => {
      const output = "src/components/Button.tsx(12,3): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'";
      
      const result = parseGateOutput(output);
      
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        file: "src/components/Button.tsx",
        line: 12,
        column: 3,
        message: "Argument of type 'string' is not assignable to parameter of type 'number'",
        severity: "error",
      });
      expect(result.warnings).toHaveLength(0);
    });

    it("should parse TypeScript warning", () => {
      const output = "src/utils/helpers.ts(45,10): warning TS6133: 'unusedVar' is declared but its value is never read";
      
      const result = parseGateOutput(output);
      
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("src/utils/helpers.ts:45:10");
    });

    it("should handle multiple TypeScript errors", () => {
      const output = `
src/component.tsx(10,5): error TS2322: Type 'string' is not assignable to type 'number'
src/component.tsx(15,8): error TS2554: Expected 2 arguments, got 3
src/utils.ts(22,3): warning TS6133: 'unused' is declared but never used
      `.trim();
      
      const result = parseGateOutput(output);
      
      expect(result.errors).toHaveLength(2);
      expect(result.warnings).toHaveLength(1);
    });
  });

  describe("ESLint error parsing", () => {
    it("should parse ESLint error with line and column", () => {
      const output = "src/components/Header.tsx:25:5 error Missing semicolon";
      
      const result = parseGateOutput(output);
      
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        file: "src/components/Header.tsx",
        line: 25,
        column: 5,
        message: "Missing semicolon",
        severity: "error",
      });
    });

    it("should parse ESLint warning", () => {
      const output = "src/utils/format.ts:12:3 warning Unused import";
      
      const result = parseGateOutput(output);
      
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(1);
    });

    it("should handle multiple ESLint errors", () => {
      const output = `
src/App.tsx:10:5 error React Hook useEffect has missing dependencies
src/App.tsx:15:3 error JSX props should use camelCase
src/utils.ts:22:1 warning Definition for rule 'custom-rule' was not found
      `.trim();
      
      const result = parseGateOutput(output);
      
      expect(result.errors).toHaveLength(2);
      expect(result.warnings).toHaveLength(1);
    });
  });

  describe("Generic error parsing", () => {
    it("should parse generic error format", () => {
      const output = "src/config.ts:42: error: Configuration file is invalid";
      
      const result = parseGateOutput(output);
      
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        file: "src/config.ts",
        line: 42,
        column: null,
        message: "Configuration file is invalid",
        severity: "error",
      });
    });

    it("should parse generic warning format", () => {
      const output = "src/deprecated.ts:15: warning: This function is deprecated";
      
      const result = parseGateOutput(output);
      
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(1);
    });
  });

  describe("Mixed error types", () => {
    it("should handle mixed TypeScript, ESLint, and generic errors", () => {
      const output = `
src/main.tsx(10,5): error TS2307: Cannot find module 'react'
src/utils.ts:15:3 error Missing return type
src/config.js:22: error: Invalid configuration
      `.trim();
      
      const result = parseGateOutput(output);
      
      expect(result.errors).toHaveLength(3);
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe("Edge cases", () => {
    it("should handle empty output", () => {
      const result = parseGateOutput("");
      
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("should handle output with no errors", () => {
      const output = "Build completed successfully";
      
      const result = parseGateOutput(output);
      
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("should flag lines containing 'error' without pattern match as warnings", () => {
      const output = "Build failed: compilation error occurred";
      
      const result = parseGateOutput(output);
      
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("Build failed");
    });

    it("should handle multiline output with empty lines", () => {
      const output = `
src/file1.ts(10,5): error TS2345: Type mismatch


src/file2.ts(20,3): error TS2554: Wrong argument count
      `.trim();
      
      const result = parseGateOutput(output);
      
      expect(result.errors).toHaveLength(2);
    });
  });
});

describe("detectPackageManager", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("should detect pnpm from pnpm-lock.yaml", async () => {
    vi.mocked(native.readDir).mockResolvedValue([
      { name: "pnpm-lock.yaml", kind: "file", size: 100, mtime: Date.now() },
      { name: "src", kind: "dir", size: 0, mtime: Date.now() },
    ]);

    const result = await detectPackageManager("/test/project");
    
    expect(result).toBe("pnpm");
  });

  it("should detect yarn from yarn.lock", async () => {
    vi.mocked(native.readDir).mockResolvedValue([
      { name: "yarn.lock", kind: "file", size: 100, mtime: Date.now() },
      { name: "package.json", kind: "file", size: 100, mtime: Date.now() },
    ]);

    const result = await detectPackageManager("/test/project");
    
    expect(result).toBe("yarn");
  });

  it("should detect bun from bun.lockb", async () => {
    vi.mocked(native.readDir).mockResolvedValue([
      { name: "bun.lockb", kind: "file", size: 100, mtime: Date.now() },
    ]);

    const result = await detectPackageManager("/test/project");
    
    expect(result).toBe("bun");
  });

  it("should detect bun from bun.lock", async () => {
    vi.mocked(native.readDir).mockResolvedValue([
      { name: "bun.lock", kind: "file", size: 100, mtime: Date.now() },
    ]);

    const result = await detectPackageManager("/test/project");
    
    expect(result).toBe("bun");
  });

  it("should detect npm from package-lock.json", async () => {
    vi.mocked(native.readDir).mockResolvedValue([
      { name: "package-lock.json", kind: "file", size: 100, mtime: Date.now() },
    ]);

    const result = await detectPackageManager("/test/project");
    
    expect(result).toBe("npm");
  });

  it("should default to pnpm when no lock file found", async () => {
    vi.mocked(native.readDir).mockResolvedValue([
      { name: "src", kind: "dir", size: 0, mtime: Date.now() },
      { name: "README.md", kind: "file", size: 100, mtime: Date.now() },
    ]);

    const result = await detectPackageManager("/test/project");
    
    expect(result).toBe("pnpm");
  });

  it("should default to pnpm on error", async () => {
    vi.mocked(native.readDir).mockRejectedValue(new Error("Directory not found"));

    const result = await detectPackageManager("/nonexistent");
    
    expect(result).toBe("pnpm");
  });
});

describe("getGateCommands", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("should return validate script if available", async () => {
    vi.mocked(native.readDir).mockResolvedValue([
      { name: "pnpm-lock.yaml", kind: "file", size: 100, mtime: Date.now() },
    ]);
    vi.mocked(native.readFile).mockResolvedValue({
      kind: "text",
      content: JSON.stringify({
        scripts: {
          validate: "tsc && eslint .",
        },
      }),
      size: 100,
    });

    const result = await getGateCommands("/test/project");
    
    expect(result).toEqual(["pnpm run validate"]);
  });

  it("should return multiple gate scripts if available", async () => {
    vi.mocked(native.readDir).mockResolvedValue([
      { name: "yarn.lock", kind: "file", size: 100, mtime: Date.now() },
    ]);
    vi.mocked(native.readFile).mockResolvedValue({
      kind: "text",
      content: JSON.stringify({
        scripts: {
          lint: "eslint .",
          test: "vitest run",
        },
      }),
      size: 100,
    });

    const result = await getGateCommands("/test/project");
    
    expect(result).toEqual(["yarn run lint", "yarn run test"]);
  });

  it("should return tsc --noEmit if no scripts but has typescript", async () => {
    vi.mocked(native.readDir).mockResolvedValue([
      { name: "package-lock.json", kind: "file", size: 100, mtime: Date.now() },
    ]);
    vi.mocked(native.readFile).mockResolvedValue({
      kind: "text",
      content: JSON.stringify({
        devDependencies: {
          typescript: "^5.0.0",
        },
      }),
      size: 100,
    });

    const result = await getGateCommands("/test/project");
    
    expect(result).toEqual(["npm exec tsc --noEmit"]);
  });

  it("should default to pnpm exec tsc --noEmit on error", async () => {
    vi.mocked(native.readDir).mockRejectedValue(new Error("Error"));

    const result = await getGateCommands("/test/project");
    
    expect(result).toEqual(["pnpm exec tsc --noEmit"]);
  });

  it("should handle missing package.json gracefully", async () => {
    vi.mocked(native.readDir).mockResolvedValue([
      { name: "src", kind: "dir", size: 0, mtime: Date.now() },
    ]);
    vi.mocked(native.readFile).mockRejectedValue(new Error("File not found"));

    const result = await getGateCommands("/test/project");
    
    expect(result).toEqual(["pnpm exec tsc --noEmit"]);
  });
});
