/**
 * Confined scratch workspace + tool policy for persona participants in
 * cross-project group chats.
 *
 * Personas own no project, but since the "full tool parity" change they run
 * with the REAL agent toolset (buildTools) against a ToolContext built here:
 *
 *   - Workspace/cwd = their per-persona scratch dir under
 *     `~/.kai/personas/<agentId-hash>/` (created lazily; persists while the
 *     persona is a member of any group, swept when it leaves its last one).
 *   - Sandbox = a `readOnly` SandboxOverride rooted at the scratch dir:
 *     READS pass anywhere the security deny-lists permit; WRITES are
 *     confined to the scratch dir. Because it is an OVERRIDE, the persona
 *     is also immune to the desktop's global sandbox root/mode (a headless
 *     persona turn must never be confined to - or by - the visible
 *     project).
 *   - Desktop-UI-bound tools (terminal IO, watches, screen capture, radio,
 *     voice, previews, terminal image/video) are EXCLUDED: they act on the
 *     foreground window's live surfaces, which a headless persona has no
 *     access to. Everything else - fs, edits, shell, search, subagents,
 *     web, memory, todos, MCP, media gen, mail/social reads - is
 *     available, with its production `needsApproval` flags intact: the
 *     persona's generateText run pauses and the group panel shows an
 *     approval card (see groupChatStore's persona approval registry).
 *
 * Tool results are fenced by the CALLER (runPersonaReply) with the persona
 * run's own fence state — scratch files can contain content fetched from
 * elsewhere, so they are untrusted from the model's perspective.
 */

import { homeDir } from "@tauri-apps/api/path";
import type { WorkspaceEnv } from "@/modules/workspace/env";
import { FileTracker } from "./fileTracker";
import type { SandboxOverride } from "./sandbox";
import type { ToolContext } from "../tools/context";

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

/** True when `path` (after collapse) stays inside the scratch root.
 *  Exposed for store-level guards and tests. */
export function personaPathWithin(path: string, root: string): boolean {
  return isWithin(collapse(path), root);
}

/** Test seam: collapse + containment without a full ToolContext. */
export const resolvePersonaPathForTest = (requested: string, root: string) =>
  personaPathWithin(requested, root)
    ? collapse(norm(requested).startsWith(norm(root).toLowerCase())
        ? requested
        : `${root}/${requested}`)
    : collapse(requested);

/**
 * Desktop-UI-bound tools a headless persona CANNOT meaningfully use. They
 * act on the foreground window's live surfaces (the visible terminal, the
 * user's display, the status-bar radio, the preview tab) or on machinery
 * keyed to a real Chat session (watches inject into the session's chat;
 * a persona has no chat). Removing them keeps the model from calling a
 * tool whose result would always be "unavailable" - and, for screen
 * capture, from grabbing the display without the interactive context a
 * foreground agent has.
 */
export const PERSONA_EXCLUDED_TOOLS: readonly string[] = [
  // terminal.ts - active-tab surfaces
  "get_terminal_output",
  "suggest_command",
  "open_preview",
  // terminalImage.ts / terminalVideo.ts - render INTO the active terminal
  "display_image",
  "display_video",
  // watch.ts - watch results inject into the owning session's Chat
  "watch_create",
  "watch_list",
  "watch_kill",
  // screen.ts - captures the user's whole display
  "look_at_screen",
  // radio.ts - status-bar music player
  "play_radio",
  "stop_radio",
  "radio_list_stations",
  "radio_now_playing",
  // voice.ts - global TTS preferences
  "voice_settings",
];

/**
 * Build the persona's ToolContext. Same shape a project session gets from
 * makeChatSync, minus the live-UI surfaces, plus the scratch-confinement
 * override. Fresh readCache + FileTracker per call (per RUN, matching the
 * per-session lifetime of the project path).
 */
export function buildPersonaToolContext(
  agentId: string,
  root: string,
  sessionId: string,
): ToolContext {
  void agentId;
  // The readOnly override is the whole write policy: reads pass, writes
  // must stay within `root`. Passed through getSandboxOverrideAsync so
  // every fs/shell/edit tool inherits it via sandboxOverrideForContext.
  const override: SandboxOverride = { root, mode: "readOnly" };
  const env: WorkspaceEnv = { kind: "local" };
  return {
    getCwd: () => root,
    getWorkspaceRoot: () => root,
    getRealWorkspaceRoot: () => root,
    workspaceEnv: env,
    getSandboxOverrideAsync: async () => override,
    // Live-UI surfaces: no desktop window follows a headless persona.
    // The tools that would call these are in PERSONA_EXCLUDED_TOOLS; the
    // stubs exist only to satisfy the ToolContext contract.
    getTerminalContext: () => null,
    isActiveTerminalPrivate: () => false,
    injectIntoActivePty: () => false,
    writeToActiveTerminalDisplay: () => false,
    openPreview: () => false,
    // Session-scoped machinery keys off the synthetic persona id: shell
    // sessions, todos, subagent shells. It is a stable, unique key, so
    // the same persona reuses its shell session across runs.
    getSessionId: () => sessionId,
    readCache: new Map(),
    fileTracker: new FileTracker(),
    // Generous static budget: persona replies are short; tools use this
    // only to truncate their own output when context is tight.
    getRemainingContextTokens: () => 128_000,
    // Persona tool results stringify on the generateText path - hand the
    // model OCR text instead of image parts (matches text-only local models).
    supportsToolResultImages: () => false,
  };
}

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
    const { native } = await import("./native");
    await native.deleteFile(root);
  } catch {
    // Already gone or FS hiccup - the sweep is best-effort.
  }
}
