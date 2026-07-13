/**
 * Tsforge-style deterministic gate tool
 * Runs build/lint/typecheck and returns structured results
 * 
 * Note: This runs shell commands through the native shell_run_command tool
 * to avoid using Node.js modules in the browser.
 */

import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import { resolvePath, type ToolContext } from "./context";

export type GateResult = {
  success: boolean;
  output: string;
  errors: GateError[];
  warnings: string[];
  durationMs: number;
};

export type GateError = {
  file: string;
  line: number | null;
  column: number | null;
  message: string;
  severity: "error" | "warning";
};

/**
 * Parse compiler/lint output into structured errors
 */
export function parseGateOutput(output: string): {
  errors: GateError[];
  warnings: string[];
} {
  const errors: GateError[] = [];
  const warnings: string[] = [];

  // TypeScript error pattern:
  // src/file.ts(12,3): error TS2345: Argument of type 'X' is not assignable to parameter of type 'Y'
  const tsErrorRe =
    /^(.+)\((\d+),(\d+)\):\s+(error|warning)\s+TS\d+:\s+(.+)$/i;

  // ESLint error pattern:
  // src/file.ts:12:3 error Missing semicolon
  const eslintErrorRe =
    /^(.+):(\d+):(\d+)\s+(error|warning)\s+(.+)$/i;

  // Generic error pattern:
  // Error: Something went wrong at src/file.ts:12
  const genericErrorRe = /^(.+):(\d+):\s*(error|warning):\s*(.+)$/i;

  const lines = output.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Try TypeScript pattern
    const tsMatch = trimmed.match(tsErrorRe);
    if (tsMatch) {
      const [, file, lineStr, colStr, severity, message] = tsMatch;
      const severityLevel =
        severity.toLowerCase() === "error" ? "error" : "warning";
      const entry: GateError = {
        file: file.trim(),
        line: Number.parseInt(lineStr, 10) || null,
        column: Number.parseInt(colStr, 10) || null,
        message: message.trim(),
        severity: severityLevel,
      };
      if (severityLevel === "error") {
        errors.push(entry);
      } else {
        warnings.push(`${file}:${lineStr}:${colStr} ${message}`);
      }
      continue;
    }

    // Try ESLint pattern
    const eslintMatch = trimmed.match(eslintErrorRe);
    if (eslintMatch) {
      const [, file, lineStr, colStr, severity, message] = eslintMatch;
      const severityLevel =
        severity.toLowerCase() === "error" ? "error" : "warning";
      const entry: GateError = {
        file: file.trim(),
        line: Number.parseInt(lineStr, 10) || null,
        column: Number.parseInt(colStr, 10) || null,
        message: message.trim(),
        severity: severityLevel,
      };
      if (severityLevel === "error") {
        errors.push(entry);
      } else {
        warnings.push(`${file}:${lineStr}:${colStr} ${message}`);
      }
      continue;
    }

    // Try generic pattern
    const genericMatch = trimmed.match(genericErrorRe);
    if (genericMatch) {
      const [, file, lineStr, severity, message] = genericMatch;
      const severityLevel =
        severity.toLowerCase() === "error" ? "error" : "warning";
      const entry: GateError = {
        file: file.trim(),
        line: Number.parseInt(lineStr, 10) || null,
        column: null,
        message: message.trim(),
        severity: severityLevel,
      };
      if (severityLevel === "error") {
        errors.push(entry);
      } else {
        warnings.push(`${file}:${lineStr} ${message}`);
      }
      continue;
    }

    // If no pattern matches but line contains "error" or "failed", flag it
    if (
      trimmed.toLowerCase().includes("error") ||
      trimmed.toLowerCase().includes("failed")
    ) {
      warnings.push(trimmed);
    }
  }

  return { errors, warnings };
}

/**
 * Detect package manager from project
 */
export async function detectPackageManager(projectPath: string): Promise<"pnpm" | "npm" | "bun" | "yarn"> {
  try {
    // Try to list directory contents to find lock files
    const files = await native.readDir(projectPath);

    if (files.some(e => e.name === "pnpm-lock.yaml")) return "pnpm";
    if (files.some(e => e.name === "yarn.lock")) return "yarn";
    if (files.some(e => e.name === "bun.lockb" || e.name === "bun.lock")) return "bun";
    if (files.some(e => e.name === "package-lock.json")) return "npm";
  } catch {
    // Default to pnpm for KAI
  }
  return "pnpm";
}

/**
 * Get gate commands for different project types
 */
export async function getGateCommands(projectPath: string): Promise<string[]> {
  const pm = await detectPackageManager(projectPath);

  try {
    // Read package.json to check for scripts
    const readResult = await native.readFile(projectPath + "/package.json");
    if (readResult.kind === "text") {
      const pkg = JSON.parse(readResult.content);

      // Check for tsforge-specific commands
      if (pkg.scripts?.validate) {
        return [`${pm} run validate`];
      }

      // Check for common gate scripts
      const gateScripts = ["validate", "check", "lint", "test"];
      const available = gateScripts.filter((script) => pkg.scripts?.[script]);

      if (available.length > 0) {
        return available.map((script) => `${pm} run ${script}`);
      }

      // Fallback to standard TypeScript check
      if (pkg.devDependencies?.typescript) {
        return [`${pm} exec tsc --noEmit`];
      }
    }
  } catch {
    // Ignore parsing errors
  }

  // Default gate commands
  return [`${pm} exec tsc --noEmit`];
}

/**
 * Run the gate on a project
 */
export async function runGate(projectPath: string): Promise<GateResult> {
  const startTime = Date.now();

  try {
    const commands = await getGateCommands(projectPath);
    const results: { command: string; output: string; exitCode: number }[] = [];

    for (const command of commands) {
      try {
        // Use runCommand to execute the command
        const result = await native.runCommand(command, projectPath, 60);
        
        results.push({
          command,
          output: (result.stdout || "") + (result.stderr || ""),
          exitCode: result.exit_code || 0,
        });
      } catch (err) {
        const error = err as {
          code?: number;
          stdout?: string;
          stderr?: string;
          message: string;
        };
        results.push({
          command,
          output: (error.stdout || "") + (error.stderr || "") + (error.message || ""),
          exitCode: error.code || 1,
        });
      }
    }

    // Combine all output
    const combinedOutput = results
      .map((r) => `${r.command}:\n${r.output}`)
      .join("\n\n");

    // Parse errors and warnings
    const { errors, warnings } = parseGateOutput(combinedOutput);

    const success = errors.length === 0;
    const durationMs = Date.now() - startTime;

    return {
      success,
      output: combinedOutput,
      errors,
      warnings,
      durationMs,
    };
  } catch (err: unknown) {
    const error = err as { message: string };
    const durationMs = Date.now() - startTime;

    return {
      success: false,
      output: `Gate execution failed: ${error.message}`,
      errors: [
        {
          file: "unknown",
          line: null,
          column: null,
          message: error.message,
          severity: "error",
        },
      ],
      warnings: [],
      durationMs,
    };
  }
}

/**
 * Build gate tool for AI agent
 */
export function buildGateTools(ctx: ToolContext) {
  return {
    /**
     * Run the project gate (build, lint, typecheck)
     * Returns structured results with errors and warnings
     */
    tsforge_gate: tool({
      description:
        "Run the project gate (build, lint, typecheck). Returns structured results with errors and warnings. Use this to validate changes before proceeding.",
      inputSchema: z.object({
        projectPath: z
          .string()
          .optional()
          .describe(
            "Path to the project root. Defaults to current working directory.",
          ),
      }),
      execute: async ({ projectPath }) => {
        const cwd = ctx.getCwd();
        if (!cwd) {
          return {
            success: false,
            summary: "❌ No working directory available",
            errorCount: 1,
            warningCount: 0,
            durationMs: 0,
            details: "Working directory is null or undefined",
            rawOutput: "",
          };
        }
        const resolvedPath = projectPath ? resolvePath(projectPath, cwd) : cwd;

        const result = await runGate(resolvedPath);

        // Format output for agent
        const summary = result.success
          ? "✅ Gate passed"
          : `❌ Gate failed with ${result.errors.length} error(s)`;

        const errorDetails =
          result.errors.length > 0
            ? "\n\nErrors:\n" +
              result.errors
                .map(
                  (e) =>
                    `  - ${e.file}:${e.line ?? "?"}:${e.column ?? "?"} ${e.message}`,
                )
                .join("\n")
            : "";

        const warningDetails =
          result.warnings.length > 0
            ? "\n\nWarnings:\n" +
              result.warnings.map((w) => `  - ${w}`).join("\n")
            : "";

        return {
          success: result.success,
          summary,
          errorCount: result.errors.length,
          warningCount: result.warnings.length,
          durationMs: result.durationMs,
          details: errorDetails + warningDetails,
          rawOutput: result.output,
        };
      },
    }),
  } as const;
}

export type GateTools = ReturnType<typeof buildGateTools>;
