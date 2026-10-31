import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Persona scratch workspace + tool policy - contract tests.
 *
 * Since the full-tool-parity change, personas run the REAL agent toolset
 * against a ToolContext built by buildPersonaToolContext:
 *   - workspace/cwd = per-persona scratch dir (~/.kai/personas/<hash>/)
 *   - sandbox = readOnly override rooted there (reads anywhere the security
 *     deny-lists permit; writes confined to the scratch dir)
 *   - desktop-UI-bound tools excluded (PERSONA_EXCLUDED_TOOLS)
 *
 * The write-confinement itself rides the production sandbox machinery
 * (already covered by sandbox/security tests); these tests pin the WIRING
 * (context shape, exclusion list contents, sweep) and the store's
 * approval-resume protocol.
 */

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: async () => "C:/Users/test",
}));

const deleteFileMock = vi.fn(async (_p: string): Promise<void> => undefined);

vi.mock("./native", () => ({
  native: {
    deleteFile: (...a: unknown[]) => deleteFileMock(...(a as [string])),
  },
}));

import {
  PERSONA_EXCLUDED_TOOLS,
  buildPersonaToolContext,
  personaPathWithin,
  personaWorkspaceRoot,
  sweepPersonaWorkspace,
} from "./personaWorkspace";

const ROOT = "C:/Users/test/.kai/personas/deadbeef";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("scratch dir resolution", () => {
  it("roots under ~/.kai/personas/<hash> and caches", async () => {
    const a = await personaWorkspaceRoot("builtin:reviewer");
    const b = await personaWorkspaceRoot("builtin:reviewer");
    expect(a).toMatch(/\/\.kai\/personas\/[0-9a-f]+$/);
    expect(a).toBe(b);
  });
});

describe("tool context policy", () => {
  it("cwd + workspace root = scratch dir; readOnly override confine writes there", async () => {
    const ctx = buildPersonaToolContext("builtin:reviewer", ROOT, "persona:builtin:reviewer");
    expect(ctx.getCwd()).toBe(ROOT);
    expect(ctx.getWorkspaceRoot()).toBe(ROOT);
    expect(ctx.getRealWorkspaceRoot?.()).toBe(ROOT);
    const override = await ctx.getSandboxOverrideAsync?.();
    expect(override).toEqual({ root: ROOT, mode: "readOnly" });
    // Session machinery keys off the synthetic persona id (shell sessions,
    // todos, subagents) so the persona reuses them across runs.
    expect(ctx.getSessionId()).toBe("persona:builtin:reviewer");
  });

  it("live-UI surfaces are inert stubs (no desktop window follows a persona)", () => {
    const ctx = buildPersonaToolContext("builtin:reviewer", ROOT, "persona:builtin:reviewer");
    expect(ctx.getTerminalContext()).toBeNull();
    expect(ctx.isActiveTerminalPrivate()).toBe(false);
    expect(ctx.injectIntoActivePty("x")).toBe(false);
    expect(ctx.writeToActiveTerminalDisplay("x")).toBe(false);
    expect(ctx.openPreview("http://x")).toBe(false);
    expect(ctx.supportsToolResultImages?.()).toBe(false);
  });
});

describe("excluded tools - desktop-UI-bound only", () => {
  it("excludes exactly the desktop/session-bound tools", () => {
    expect(PERSONA_EXCLUDED_TOOLS).toEqual([
      "get_terminal_output",
      "suggest_command",
      "open_preview",
      "display_image",
      "display_video",
      "watch_create",
      "watch_list",
      "watch_kill",
      "look_at_screen",
      "play_radio",
      "stop_radio",
      "radio_list_stations",
      "radio_now_playing",
      "voice_settings",
    ]);
  });

  it("does NOT exclude the productive agent tools", () => {
    const excluded = new Set(PERSONA_EXCLUDED_TOOLS);
    // File/edit/shell/search/web/subagent/memory/todo/media tools must remain.
    for (const kept of [
      "read_file",
      "write_file",
      "list_directory",
      "edit",
      "batch_edit",
      "replace_exact",
      "bash_run",
      "bash_background",
      "bash_logs",
      "bash_kill",
      "bash_list",
      "grep",
      "glob",
      "web_search",
      "web_browse",
      "run_subagent",
      "save_memory",
      "todo_write",
      "generate_image",
      "generate_video",
      "gmail_read",
      "social_read",
      "mcp_list_servers",
    ]) {
      expect(excluded.has(kept)).toBe(false);
    }
  });
});

describe("sweep", () => {
  it("deletes the scratch dir best-effort", async () => {
    await sweepPersonaWorkspace("builtin:reviewer");
    expect(deleteFileMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/\.kai\/personas\/[0-9a-f]+$/),
    );
  });
});

describe("pure containment math", () => {
  it("absolute outside vs inside", () => {
    expect(personaPathWithin("C:/Code/app", ROOT)).toBe(false);
    expect(personaPathWithin(`${ROOT}/sub/file`, ROOT)).toBe(true);
    expect(personaPathWithin(`${ROOT}\\sub\\file`, ROOT)).toBe(true);
  });
});

describe("source pins - wiring & approval protocol", () => {
  it("the store builds the full toolset with production wrapping + approval loop", () => {
    const store = readFileSync(new URL("../store/groupChatStore.ts", import.meta.url), "utf8");
    // Full registry, minus exclusions + group tools.
    expect(store).toContain("buildTools(toolContext, mcpTools)");
    expect(store).toContain("PERSONA_EXCLUDED_TOOLS");
    expect(store).toContain('"send_to_project", "project_status"');
    // Production wrapping order preserved.
    expect(store).toContain("withToolRedaction(");
    expect(store).toContain("withCentralToolGuards(");
    expect(store).toContain("withToolGuard(");
    // Approval resume protocol: SDK approvalIds mapped from request parts.
    expect(store).toContain('"tool-approval-request"');
    expect(store).toContain('"tool-approval-response"');
    expect(store).toContain("approvalIdByToolCall");
    // Teardown denies pending cards (absence of permission is denial).
    expect(store).toContain("denyPersonaApprovals(key)");
    // Step cap still enforced per round.
    expect(store).toContain("stepCountIs(PERSONA_MAX_STEPS)");
  });

  it("the panel renders persona approval cards and routes decisions", () => {
    const panel = readFileSync(new URL("../components/GroupChatPanelView.tsx", import.meta.url), "utf8");
    // Phase 1 unified the approval surface: personas + background sessions
    // render through the SAME rich AiToolApproval card, enumerated by
    // unifiedGroupApprovals and decided via respondUnifiedApproval (which
    // routes persona ids to respondPersonaApproval internally). The old
    // persona-only simple card is superseded - pinned in
    // groupApprovals.test.ts.
    expect(panel).toContain("getPersonaApprovals");
    expect(panel).toContain("unifiedGroupApprovals");
    expect(panel).toContain("<AiToolApproval");
    expect(panel).toContain("<GroupApprovals group={active} />");
  });

  it("persona activity reports approval state before working", () => {
    const store = readFileSync(new URL("../store/groupChatStore.ts", import.meta.url), "utf8");
    // Approval check runs inside the persona branch of participantActivity,
    // before the busy-set check.
    expect(store).toContain("entry.sessionKey.endsWith(`::${sessionId}`)) return \"approval\"");
    expect(store.indexOf("return \"approval\"")).toBeLessThan(
      store.indexOf("personaBusyBySession.has(sessionId)) return \"working\""),
    );
  });
});
