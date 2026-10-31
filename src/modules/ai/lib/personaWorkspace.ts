/**
 * Confined scratch workspace for persona participants in cross-project
 * group chats.
 *
 * Personas own no project. Their toolset for group replies is:
 *   - read_file / list_directory: allowed ANYWHERE on the machine (same
 *     security deny-lists as project agents: .env, .ssh, credentials…)
 *   - write_file: allowed ONLY inside their per-persona scratch dir under
 *     `~/.kai/personas/<agentId-hash>/` — created lazily on first use.
 *
 * The write confinement reuses the production sandbox machinery instead of
 * hand-rolling it: `checkWritableCanonical` with a `readOnly`
 * SandboxOverride rooted at the scratch dir. readOnly mode is exactly this
 * contract (reads pass, writes confined), and passing the override also
 * neutralizes the global desktop sandbox (owned by App.tsx for the visible
 * project — a headless persona turn must never be confined to, or by, the
 * desktop project).
 *
 * Containment is defense-in-depth, same pair as the project fs tools:
 * the literal path is checked, then the canonicalized path re-checked, so
 * traversal (`..`) and symlink escapes are caught after resolution.
 *
 * Tool results are fenced by the CALLER (runPersonaReply) via
 * withToolGuard + the persona run's own fence state — scratch files can
 * contain content the persona fetched from elsewhere, so they are
 * untrusted from the model's perspective.
 *
 * Sweep: scratch dirs persist across runs (a persona in two groups shares
 * one dir — sweeping on group end would destroy the other group's work).
 * They are removed when the persona is no longer a member of ANY group
 * (live or ended), see `sweepPersonaWorkspace`.
 */

import { homeDir } from "@tauri-apps/api/path";
import { z } from "zod";
import { native } from "./native";
import { checkReadableCanonical, checkWritableCanonical } from "./security";
import type { SandboxOverride } from "./sandbox";

const PERSONA_READ_SCHEMA = z.object({
  path: z.string().describe("Absolute path, or a path relative to your scratch workspace."),
});
const PERSONA_WRITE_SCHEMA = z.object({
  path: z.string().describe("Path inside your scratch workspace (absolute or relative to it)."),
  content: z.string().describe("Full file content to write. Parent folders are created automatically."),
});
const PERSONA_LIST_SCHEMA = z.object({
  path: z
    .string()
    .optional()
    .describe("Absolute directory path, or a path relative to your scratch workspace. Defaults to the workspace root."),
});

/** Hash a path string into a safe filename component (DJB2, same as kaiPaths). */
function djb2(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

function norm(p: string): string {
  let s = p.replace(/\\/g, "/");
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

/** True when `abs` is inside `root` (case-insensitive, drive-letter aware). */
function isWithin(abs: string, root: string): boolean {
  const a = norm(abs);
  const r = norm(root);
  const al = a.toLowerCase();
  const rl = r.toLowerCase();
  return al === rl || al.startsWith(`${rl}/`);
}

/** Collapse `.`/`..` segments in a normalized forward-slash path. */
function collapse(p: string): string {
  const out: string[] = [];
  for (const seg of norm(p).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(seg);
  }
  // Preserve the Windows drive prefix (the first segment can be "C:").
  if (out.length > 0 && /^[a-zA-Z]:$/.test(out[0]!)) {
    return `${out[0]}/${out.slice(1).join("/")}`;
  }
  return out.join("/");
}

function isAbsolute(p: string): boolean {
  return p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

const resolved = new Map<string, string>();

/**
 * Resolve (and cache) a persona's scratch dir under
 * `~/.kai/personas/<hash-of-agentId>/`. The hash keeps agent ids (which may
 * contain `:` or other path-hostile chars) out of the filesystem.
 * Returns null when the home dir is unavailable (headless tests) — callers
 * treat that as "no scratch workspace; persona runs without tools".
 */
export async function personaWorkspaceRoot(agentId: string): Promise<string | null> {
  const cached = resolved.get(agentId);
  if (cached) return cached;
  try {
    const home = await homeDir();
    const homeNorm = home.replace(/\\/g, "/").replace(/\/+$/, "");
    const dir = `${homeNorm}/.kai/personas/${djb2(agentId).toString(16)}`;
    resolved.set(agentId, dir);
    return dir;
  } catch {
    return null;
  }
}

/** Resolve a persona tool path: absolute passes through; relative joins the
 *  scratch root and is collapsed so `..` stays verifiable. */
function resolvePersonaToolPath(root: string, requested: string): string {
  if (isAbsolute(requested)) return collapse(requested);
  return collapse(`${root}/${requested}`);
}

export type PersonaToolDef = {
  description: string;
  inputSchema: unknown;
  execute: (input: never) => Promise<unknown>;
};

/**
 * Build the persona's confined toolset. Results are fenced by the caller
 * (runPersonaReply) with the persona run's own fence state via
 * withToolGuard — never passed to generateText unwrapped.
 *
 * Policy (user-specified):
 *   - READS (read_file, list_directory): anywhere on the machine, through
 *     the same security deny-lists + canonical re-checks as project agents.
 *     The readOnly override means no global sandbox can confine the persona
 *     to the desktop project.
 *   - WRITES (write_file): inside the scratch root ONLY. The readOnly
 *     sandbox override enforces this at the security layer — a write outside
 *     the root is refused before any filesystem call happens.
 */
export function buildPersonaTools(
  agentId: string,
  root: string,
  options: { readLimitBytes?: number } = {},
): Record<string, PersonaToolDef> {
  const readLimit = options.readLimitBytes ?? 2_000_000;
  // The readOnly override is the whole write policy: reads pass, writes
  // must stay within `root`. It also decouples the persona from the
  // desktop's global sandbox root/mode.
  const override: SandboxOverride = { root, mode: "readOnly" };
  void agentId;
  return {
    read_file: {
      description:
        "Read a file's content. Absolute paths may point anywhere on this machine (sensitive paths like .env or .ssh are refused); relative paths resolve against your scratch workspace.",
      inputSchema: PERSONA_READ_SCHEMA,
      execute: async (input: { path: string }) => {
        const abs = resolvePersonaToolPath(root, input.path);
        const check = await checkReadableCanonical(abs, (p) => native.canonicalize(p), override);
        if (!check.ok) return { error: check.reason };
        try {
          const r = await native.readFile(check.canonical);
          if (r.kind === "binary") {
            return { error: `binary file (${r.size} bytes) - not readable as text` };
          }
          if (r.kind === "toolarge") {
            return { error: `file too large (${r.size} bytes, limit ${r.limit})` };
          }
          const truncated = r.size > readLimit;
          const content = truncated ? r.content.slice(0, readLimit) : r.content;
          return { path: check.canonical, content, truncated, size: r.size };
        } catch (e) {
          return { error: String(e) };
        }
      },
    },
    write_file: {
      description:
        "Write a file (full content) into your personal scratch workspace — the ONLY place you may write. Parent folders are created automatically. Absolute paths are accepted only when they are inside the scratch workspace.",
      inputSchema: PERSONA_WRITE_SCHEMA,
      execute: async (input: { path: string; content: string }) => {
        const abs = resolvePersonaToolPath(root, input.path);
        const check = await checkWritableCanonical(abs, (p) => native.canonicalize(p), override);
        if (!check.ok) return { error: check.reason };
        try {
          await native.writeFile(check.canonical, input.content);
          return { path: check.canonical, bytesWritten: input.content.length };
        } catch (e) {
          return { error: String(e) };
        }
      },
    },
    list_directory: {
      description:
        "List the immediate entries of a directory. Absolute paths may point anywhere on this machine; relative paths resolve against your scratch workspace. Defaults to the scratch workspace root.",
      inputSchema: PERSONA_LIST_SCHEMA,
      execute: async (input: { path?: string }) => {
        const abs = resolvePersonaToolPath(root, input.path ?? ".");
        const check = await checkReadableCanonical(abs, (p) => native.canonicalize(p), override);
        if (!check.ok) return { error: check.reason };
        try {
          const entries = await native.readDir(check.canonical);
          return {
            path: check.canonical,
            entries: entries.map((e) => ({ name: e.name, kind: e.kind })),
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    },
  };
}

/** True when `path` (after collapse) stays inside the scratch root.
 *  Exposed for store-level guards (queue telemetry, sweeps). */
export function personaPathWithin(path: string, root: string): boolean {
  return isWithin(collapse(path), root);
}

/** Test seam: resolvePersonaToolPath without a full ToolContext. */
export const resolvePersonaPathForTest = resolvePersonaToolPath;

/**
 * Remove a persona's scratch workspace. Called when the persona is no
 * longer a member of any group (removed from its last group, or its last
 * group was deleted) so scratch content never lingers on disk. Best-effort:
 * failures are swallowed (lifecycle paths must not fail because a sweep
 * hiccuped). Group END deliberately does NOT sweep — ended groups resume
 * with their participants intact.
 */
export async function sweepPersonaWorkspace(agentId: string): Promise<void> {
  const root = await personaWorkspaceRoot(agentId);
  if (!root) return;
  resolved.delete(agentId);
  try {
    await native.deleteFile(root);
  } catch {
    // Already gone or FS hiccup - the sweep is best-effort.
  }
}
