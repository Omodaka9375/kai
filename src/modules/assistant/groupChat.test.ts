import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Group-chat support contract (2026-11-02): allow-listed Telegram groups
 * can chat with the assistant — one SHARED session per group (user
 * decision), sender attribution, and a READ-ONLY tool tier for members.
 *
 * User ask: "can I add my assistant to a group chat with my friends, will
 * it respond to them?" — answer: yes, with these security properties:
 *   1. GROUP BIND is owner-only: /bindgroup inside the group while bind
 *      mode is armed in Settings; Rust verifies the sender is the owner
 *      before emitting the candidate. A member cannot add their own group.
 *   2. The allow-list persists in prefs (boundGroups) and is pushed into
 *      the Rust gate on every telegram_start — classify() alone never
 *      mutates it.
 *   3. Members get GROUP_ALLOWED_TOOLS (a read-tier SUBSET that excludes
 *      the owner-private channels: reminders, settings) regardless of
 *      what the owner granted THEMSELVES — never shell, file writes,
 *      API-spend tools, MCP, or set_my_name.
 *   4. Slash commands (/tell /sessions /approve...) are owner-only.
 */

// NOTE depth: sources pinned are CWD-relative.
const rust = readFileSync(
  new URL("../../../src-tauri/src/modules/telegram.rs", import.meta.url),
  "utf8",
);
const index = readFileSync(
  new URL("./index.ts", import.meta.url),
  "utf8",
);
const prefs = readFileSync(
  new URL("./prefs.ts", import.meta.url),
  "utf8",
);
const settings = readFileSync(
  new URL("../../../src/settings/sections/ExternalSection.tsx", import.meta.url),
  "utf8",
);

describe("Rust gate: allow-listed groups + owner-only /bindgroup", () => {
  it("the allow-list is a Rust-side list refreshed by every telegram_start", () => {
    expect(rust).toContain("static BOUND_GROUP_IDS");
    expect(rust).toMatch(/bound_group_ids: Option<Vec<i64>>/);
    expect(rust).toMatch(/telegram_start[\s\S]*?\*groups = bound_group_ids\.unwrap_or_default\(\)/);
  });

  it("classify() gates groups: allow-list membership decides, /bindgroup is owner-verified", () => {
    // The gate reads the list — never writes it.
    expect(rust).toContain("groups.contains(&chat_id)");
    // /bindgroup handshake: armed by telegram_bind_group, consumed once,
    // and ONLY when the sender matches the owner.
    expect(rust).toContain("static GROUP_BIND_MODE");
    expect(rust).toContain('t.trim() == "/bindgroup"');
    expect(rust).toContain("sender_is_owner");
    expect(rust).toContain("GroupBindCandidate");
  });

  it("group messages carry sender attribution", () => {
    expect(rust).toContain("sender_name,");
    expect(rust).toContain("is_group,");
    expect(rust).toMatch(/struct TgUser[\s\S]*?first_name/);
  });
});

describe("TS: shared per-group session + attribution + read-only member tier", () => {
  it("group turns run in a deterministic per-group session", () => {
    expect(index).toContain('const groupSessionKey = (groupChatId: number) => `group-${groupChatId}`');
    expect(index).toContain("getOrCreateGroupSession(opts.groupChatId)");
    expect(index).toMatch(/opts\?\.groupChatId != null\s*\n\s*\? await getOrCreateGroupSession/);
  });

  it("member messages are attributed with the sender's display name", () => {
    expect(index).toContain('`[${opts.groupSenderName}]: ${userText}`');
  });

  it("members get the GROUP SUBSET regardless of the owner's allowlist", () => {
    // FIX 7 (2026-11-02 review): GROUP_ALLOWED_TOOLS, not the full read
    // tier (regex-literal escapes don't round-trip through the tool
    // pipeline; indexOf assertions instead).
    // The ternary: group turns spread GROUP_ALLOWED_TOOLS (both lines exist,
    // and the spread references the group set by name).
    expect(index).toContain("const allowed = opts?.isGroup");
    expect(index).toContain("? new Set<string>([...GROUP_ALLOWED_TOOLS])");
    expect(index).toContain('import { GROUP_ALLOWED_TOOLS, isToolAllowed } from "./toolCatalog";');
  });

  it("members get NO MCP and NO set_my_name", () => {
    expect(index).toContain("const mcpTools = opts?.isGroup");
    expect(index).toContain('if (!opts?.isGroup) Object.assign(tools, buildAssistantNameTool());');
  });

  it("slash commands are owner-only: a group /tell is silently dropped", () => {
    expect(index).toMatch(
      /if \(e\.isGroup\) \{\s*\n\s*const text = e\.text \?\? "";\s*\n\s*if \(text\.trim\(\)\.startsWith\("\/"\)\) return;/,
    );
  });

  it("the groupBindCandidate handler persists the group + arms the shared session", () => {
    expect(index).toContain('if (e.kind === "groupBindCandidate")');
    expect(index).toContain("bound.add(e.chatId)");
    expect(index).toContain("getOrCreateGroupSession(e.chatId)");
  });
});

describe("prefs + settings surface", () => {
  it("boundGroups persists in assistant prefs and rides the start call", () => {
    expect(prefs).toContain("boundGroups: number[];");
    expect(prefs).toContain("boundGroups: [],");
    expect(prefs).toContain("boundGroupIds: prefs.boundGroups ?? []");
    // TelegramEvent carries the attribution fields.
    expect(prefs).toContain("senderName: string; isGroup: boolean;");
    expect(prefs).toContain('kind: "groupBindCandidate"');
  });

  it("Settings shows the Add-group handshake button (owner-bound gate)", () => {
    expect(settings).toContain("telegram_bind_group");
    expect(settings).toContain("Add group");
    expect(settings).toContain("/bindgroup inside the group");
  });
});

describe("Rust: start payload pushes the persisted group list", () => {
  it("telegram_start accepts bound_group_ids (camelCase maps to snake_case param)", () => {
    // The IPC contract: JS `boundGroupIds` maps to Rust `bound_group_ids`.
    expect(rust).toContain("bound_group_ids: Option<Vec<i64>>");
  });
});

describe("group-tier + session hygiene (2026-11-02 review, fixes 7-8)", () => {
  it("the member tier excludes the owner-private channels", () => {
    const catalog = readFileSync(new URL("./toolCatalog.ts", import.meta.url), "utf8");
    expect(catalog).toContain("export const GROUP_ALLOWED_TOOLS");
    const open = catalog.indexOf("export const GROUP_ALLOWED_TOOLS");
    const close = catalog.indexOf("];", open);
    const groupBody = catalog.slice(open, close);
    // The owner-private channels must NOT be in the group set (they live
    // elsewhere in the catalog for the owner tier - that's fine).
    for (const excluded of ["reminder_create", "reminder_list", "reminder_cancel", "settings", "gmail_read", "social_read"]) {
      expect(groupBody).not.toContain('"' + excluded + '"');
    }
    // The group prompt claims ZERO MCP servers and no customInstructions.
    expect(index).toContain("opts?.isGroup ? 0 : prefs.mcpAllowedServers.length");
    expect(index).toContain("custom && !opts?.isGroup");
  });

  it("getOrCreateGroupSession writes the row directly (no ghost placeholder)", () => {
    // FIX 8: the old flow persisted a random-id ghost via createSession and
    // filtered the wrong row. The direct write must remain.
    const fnStart = index.indexOf("export async function getOrCreateGroupSession");
    const fnEnd = index.indexOf("async function persistHistory", fnStart);
    const body = index.slice(fnStart, fnEnd);
    expect(body).not.toContain("createSession(");
    expect(body).toContain("sessionsCache = [entry, ...list].slice(0, MAX_SESSIONS);");
  });
});
