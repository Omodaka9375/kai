import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import { checkShellCommand } from "../lib/security";
import type { ToolContext } from "./context";
import { currentWorkspaceEnv, workspaceScopeKey } from "@/modules/workspace";

/**
 * Per-session lazy shell-session id. The agent gets one persistent shell per
 * chat session, so cwd survives across tool calls (cd, mkdir+cd, etc).
 */
const sessionShells = new Map<string, Promise<number>>();

/** Cancel all running shell session commands. Called on agent stop. */
export function cancelAllShellSessions(): void {
  for (const p of sessionShells.values()) {
    void p.then((id) => {
      native.shellSessionCancel(id);
      // If the cancel flag didn't take effect (e.g. the child process is
      // unkillable or stuck in a blocking syscall), close the entire session
      // after a grace period so the next run gets a fresh shell.
      setTimeout(() => {
        native.shellSessionClose(id);
      }, 3000);
    }).catch(() => {});
  }
  // Also clear the session map so the next agent run creates a fresh shell
  // instead of reusing the stuck one.
  sessionShells.clear();
}

/** Close and remove the shell session for a deleted chat session. */
export function closeShellSession(sessionId: string): void {
  // Session keys are workspace-scoped; scan for any key starting with the
  // session id since we don't know the workspace scope at deletion time.
  for (const [key, p] of sessionShells) {
    if (key === sessionId || key.startsWith(`${sessionId}:`)) {
      void p.then((id) => native.shellSessionClose(id)).catch(() => {});
      sessionShells.delete(key);
    }
  }
}

async function getSessionShell(
  sessionId: string,
  cwd: string | null,
): Promise<number> {
  let p = sessionShells.get(sessionId);
  if (!p) {
    p = native.shellSessionOpen(cwd);
    sessionShells.set(sessionId, p);
  }
  return p;
}

function workspaceSessionKey(sessionId: string): string {
  return `${sessionId}:${workspaceScopeKey(currentWorkspaceEnv())}`;
}

/**
 * Package-manager commands that are NOT dev servers — install, build, test,
 * lint, etc. Checked BEFORE dev-server patterns to avoid false positives
 * (e.g. `pnpm add @next/dev-utils` matching `\bdev\b`).
 * Not anchored with ^ so chained commands like `cd project && pnpm install`
 * are also recognized.
 */
function isPackageManagerForegroundCommand(cmd: string): boolean {
  const lower = cmd.toLowerCase();
  return /\b(npm|pnpm|yarn|bun)\s+(add|install|i|ci|remove|uninstall|up|update|upgrade|link|dedupe|build|run\s+build|test|run\s+test|lint|run\s+lint|typecheck|run\s+typecheck|format|run\s+format|check|run\s+check|run\s+preview|pack|publish|exec|dlx|why|ls|list|outdated|audit|prune|rebuild|clean)\b/.test(
    lower,
  );
}

/** Default timeout override for slow-but-foreground commands (seconds). */
function slowCommandTimeout(cmd: string): number | undefined {
  const lower = cmd.toLowerCase();
  // Package install commands — network I/O, can take 2+ minutes.
  if (/\b(npm|pnpm|yarn|bun)\s+(add|install|i|ci|update|upgrade)\b/.test(lower)) return 120;
  // Build commands — Rust/TS compilation can take 5+ minutes.
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b/.test(lower)) return 300;
  if (/\b(cargo\s+build|cargo\s+test|tsc)\b/.test(lower)) return 300;
  // Test/lint — usually under 2 minutes but give headroom.
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|typecheck|check)\b/.test(lower)) return 120;
  return undefined;
}

/** Detect commands that are long-running dev servers / watchers. */
function isDevServerCommand(cmd: string): boolean {
  // Package manager foreground commands are not servers — never block them.
  if (isPackageManagerForegroundCommand(cmd)) return false;
  const lower = cmd.toLowerCase().trim();
  // More specific patterns: require package-runner context or standalone
  // server binaries. Bare `\bdev\b` and `\bstart\b` were too broad.
  const DEV_PATTERNS = [
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?dev\b/,
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?start\b/,
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?serve\b/,
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?watch\b/,
    /\bnext\s+dev\b/,
    /\bvite\b(?!.*build)/,
    /\bgatsby\s+develop\b/,
    /\bng\s+serve\b/,
    /\bflask\s+run\b/,
    /\buvicorn\b/,
    /\bgunicorn\b/,
    /\bnodemon\b/,
    /\btsx\s+watch\b/,
    /\bcargo\s+watch\b/,
    /\blive-server\b/,
    /\bhttp-server\b/,
    /\btailwindcss.*--watch\b/,
  ];
  return DEV_PATTERNS.some((re) => re.test(lower));
}

/** Detect interactive commands that prompt for input (stdin is null so they hang). */
function getInteractiveCommandHint(cmd: string): string | null {
  const lower = cmd.toLowerCase().trim();
  // npm/pnpm/yarn create / init scaffolders
  if (
    /\b(npm|pnpm|yarn|npx|bunx?)\s+(create|init)\b/.test(lower) ||
    /\b(npx|bunx?)\s+create-/.test(lower)
  ) {
    return `"${cmd}" is interactive and will hang (stdin is not connected). Instead, write the project files directly using write_file — create package.json, index.html, src/main.jsx, vite.config.js, etc. manually. This is faster and more reliable than running a scaffolder.`;
  }
  // Other known interactive commands
  if (/\b(vim|nano|less|more|top|htop|man)\b/.test(lower)) {
    return `"${cmd}" is interactive and cannot run in this shell (no TTY). Use non-interactive alternatives.`;
  }
  return null;
}

const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

export function buildShellTools(ctx: ToolContext) {
  return {
    bash_run: tool({
      description:
        "Run a foreground shell command in this session's persistent agent shell. cwd persists across calls (so `cd foo` then `bash_run pwd` works). Use for short-lived commands (lint, test, search, build). For long-running or daemon processes (dev servers, watch tasks), use `bash_background`. NEVER invoke interactive tools (vim, less, top) — they will hang. Asks for user approval.",
      inputSchema: z.object({
        command: z.string(),
        timeout_secs: z.number().min(1).max(300).optional(),
      }),
      needsApproval: true,
      execute: async ({ command, timeout_secs }) => {
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        // Block long-running dev server commands — they hang bash_run.
        if (isDevServerCommand(command)) {
          return {
            error: `"${command}" is a long-running dev server. Use bash_background instead of bash_run for dev servers, watchers, and daemons. Then use bash_logs to read output and open_preview to show the page.`,
          };
        }
        // Block interactive scaffolding commands that prompt for input.
        const scaffoldHint = getInteractiveCommandHint(command);
        if (scaffoldHint) {
          return { error: scaffoldHint };
        }
        const sid = ctx.getSessionId();
        if (!sid) return { error: "no active chat session" };
        try {
          const cwd = ctx.getCwd();
          const shellId = await getSessionShell(workspaceSessionKey(sid), cwd);
          const effectiveTimeout =
            timeout_secs ?? slowCommandTimeout(command);

          // Auto-append --yes to npx commands to prevent interactive installation prompts from hanging the shell
          let sanitizedCommand = command;
          if (/\bnpx\b/.test(sanitizedCommand) && !/\b(npx\s+(?:-y|--yes))\b/.test(sanitizedCommand)) {
            sanitizedCommand = sanitizedCommand.replace(/\bnpx\b/g, "npx --yes");
          }

          const r = await native.shellSessionRun(
            shellId,
            sanitizedCommand,
            cwd,
            effectiveTimeout,
          );
          return {
            command: sanitizedCommand,
            stdout: stripAnsi(r.stdout),
            stderr: stripAnsi(r.stderr),
            exit_code: r.exit_code,
            timed_out: r.timed_out,
            truncated: r.truncated,
            cwd_after: r.cwd_after,
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    bash_background: tool({
      description:
        "Spawn a long-running background process (e.g. `pnpm dev`, `cargo watch`, log tailers). Returns a handle; use `bash_logs` to read its output and `bash_kill` to stop it. Output is captured into a 4MB ring buffer. Asks for user approval.",
      inputSchema: z.object({
        command: z.string(),
        cwd: z.string().nullable().optional(),
      }),
      needsApproval: true,
      execute: async ({ command, cwd }) => {
        const safety = checkShellCommand(command);
        if (!safety.ok) return { error: safety.reason };
        const effectiveCwd = cwd ?? ctx.getCwd();
        try {
          const handle = await native.shellBgSpawn(command, effectiveCwd);
          return { handle, command, cwd: effectiveCwd, ok: true };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    bash_logs: tool({
      description:
        "Read accumulated logs from a `bash_background` process. Pass `since_offset` from the previous response's `next_offset` to tail incrementally. `dropped` reports bytes evicted by the ring buffer.",
      inputSchema: z.object({
        handle: z.number(),
        since_offset: z.number().optional(),
      }),
      execute: async ({ handle, since_offset }) => {
        try {
          const r = await native.shellBgLogs(handle, since_offset);
          return {
            ...r,
            bytes: stripAnsi(r.bytes),
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    bash_list: tool({
      description:
        "List all background processes spawned by `bash_background` in this app — running and exited. **Always call this BEFORE spawning a new long-running process** (especially dev servers like `pnpm dev`, `next dev`, `vite`) to avoid duplicates. If a matching process is already running, reuse it (call `open_preview` again instead of respawning). Auto-executes.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const list = await native.shellBgList();
          return { processes: list };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),

    bash_kill: tool({
      description:
        "Terminate a `bash_background` process by handle. Idempotent — kills nothing if the handle is unknown or already exited.",
      inputSchema: z.object({ handle: z.number() }),
      execute: async ({ handle }) => {
        try {
          await native.shellBgKill(handle);
          return { handle, ok: true };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),
  } as const;
}
