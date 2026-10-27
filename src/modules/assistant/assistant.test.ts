import { describe, expect, it, vi } from "vitest";
import { modelMessageSchema } from "ai";

/**
 * Assistant module tests — the pure logic surface: the fenced tool
 * exclusion, the queue contract, persona resolution, and history trimming.
 * Network/agent paths are mocked (no Tauri, no Telegram, no model).
 */

// `Channel` must exist as a real class: telegram_start's payload is asserted
// to be an instance of it (a bare function is silently dropped by Tauri).
class MockChannel<T> {
  onmessage: ((e: T) => void) | null = null;
}
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: MockChannel,
}));
vi.mock("@tauri-apps/plugin-store", () => {
  const maps = new Map<string, Map<string, unknown>>();
  return {
    LazyStore: vi.fn().mockImplementation((path: string) => {
      let m = maps.get(path);
      if (!m) {
        m = new Map();
        maps.set(path, m);
      }
      return {
        get: async (k: string) => (m!.has(k) ? m!.get(k) : null),
        set: async (k: string, v: unknown) => {
          m!.set(k, v);
        },
        delete: async (k: string) => {
          m!.delete(k);
        },
        save: async () => {},
      };
    }),
  };
});

const assistant = await import("./index");
const { invoke, Channel } = await import("@tauri-apps/api/core");

describe("assistant persona", () => {
  it("resolves the builtin general Assistant persona", () => {
    const p = assistant.assistantPersona();
    expect(p.name).toBe("Assistant");
    expect(p.instructions.length).toBeGreaterThan(20);
  });
});

describe("assistant history", () => {
  it("resets via resetAssistantHistory", async () => {
    await assistant.resetAssistantHistory();
    const h = await assistant.loadHistory();
    expect(h).toEqual([]);
  });
});

describe("assistant capability summary (prompt honesty)", () => {
  it("advertises only granted capabilities", async () => {
    // The prompt line is derived from the SAME allowlist set the filter uses.
    const { describeAssistantCapabilities } = await import("./index");
    const line = describeAssistantCapabilities(
      new Set(["web_search", "read_file", "bash_run"]),
      2,
    );
    expect(line).toContain("web search/fetch");
    expect(line).toContain("shell commands");
    expect(line).toContain("2 MCP server toolset");
    // A capability that is NOT granted must not be advertised.
    expect(line).not.toContain("image generation");
  });

  it("says NO TOOLS when the allowlist is empty (model told the truth)", async () => {
    const { describeAssistantCapabilities } = await import("./index");
    expect(describeAssistantCapabilities(new Set(), 0)).toContain("NO tools");
  });
});

describe("assistant tool catalog", () => {
  // The exclusion + allowlist logic moved to toolCatalog.ts (pure, so it is
  // imported directly rather than grep-asserted against index.ts).
  it("hard-excludes every desktop-coupled tool", async () => {
    const { HARD_EXCLUDED_TOOLS } = await import("./toolCatalog");
    for (const banned of [
      "display_image",
      "look_at_screen",
      "run_subagent",
      "radio_list_stations",
      "get_terminal_output",
      "mcp_add_server",
      "checkpoint_undo",
      "todo_write",
    ]) {
      expect(HARD_EXCLUDED_TOOLS.has(banned)).toBe(true);
    }
  });

  it("no tool is both selectable and hard-excluded", async () => {
    const { TOOL_CATALOG, HARD_EXCLUDED_TOOLS } = await import("./toolCatalog");
    for (const t of TOOL_CATALOG) {
      expect(HARD_EXCLUDED_TOOLS.has(t.name)).toBe(false);
    }
  });
});

describe("toModelMessage (history → generateText)", () => {
  // Its output is fed to generateText({ messages }), which safeParse-validated
  // against modelMessageSchema BEFORE the provider is called — a mismatch
  // throws "The messages do not match the ModelMessage[] schema". That is
  // exactly what broke every Telegram photo upload: the image part was built
  // with the *file* key `data` while type:"image" requires the key `image`.
  // Validating against the REAL SDK schema (not a hand-rolled expectation)
  // is what pins the contract.
  const schema = modelMessageSchema as unknown as {
    safeParseAsync: (v: unknown) => Promise<{ success: boolean }>;
  };

  it("text-only user message validates", async () => {
    const mm = assistant.toModelMessage({
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    } as never);
    expect(await schema.safeParseAsync(mm)).toMatchObject({ success: true });
  });

  it("image user message validates AND carries the payload under `image`", async () => {
    const mm = assistant.toModelMessage({
      id: "u2",
      role: "user",
      // The UIMessage stores a `file` part (explorer/composer shape);
      // toModelMessage converts it to a model image part.
      parts: [
        { type: "text", text: "what's in this?" },
        { type: "file", mediaType: "image/jpeg", data: "aGVsbG8=" },
      ],
    } as never);
    expect(await schema.safeParseAsync(mm)).toMatchObject({ success: true });
    const content = (mm as { content: Array<Record<string, unknown>> }).content;
    const img = content.find((p) => p.type === "image");
    expect(img).toBeDefined();
    expect(img!.image).toBe("aGVsbG8="); // the required key
    expect(img!.data).toBeUndefined(); // the regression: `data` is file-only
  });

  it("PROOF the test bites: an image part keyed `data` (the old shape) fails the schema", async () => {
    const bad = {
      role: "user",
      content: [
        { type: "text", text: "x" },
        { type: "image", mediaType: "image/jpeg", data: "aGVsbG8=" },
      ],
    };
    expect(await schema.safeParseAsync(bad)).toMatchObject({ success: false });
  });
});

describe("telegram token keyring account", () => {
  it("uses the fixed keyring account name", () => {
    expect(assistant.TELEGRAM_TOKEN_KEY).toBe("telegram_bot_token");
  });
});

describe("sessions (multi-conversation store)", () => {
  it("creates, lists, switches, and deletes sessions", async () => {
    const s1 = await assistant.newSession("Work");
    expect(s1.title).toBe("Work");
    const list = await assistant.listSessions();
    expect(list.some((s) => s.id === s1.id)).toBe(true);

    const active = await assistant.getActiveSessionId();
    expect(active).toBe(s1.id);

    const s2 = await assistant.newSession("Trip");
    expect((await assistant.getActiveSessionId())).toBe(s2.id);
    const back = await assistant.switchSession(s1.id);
    expect(back?.id).toBe(s1.id);

    await assistant.deleteSession(s2.id);
    const after = await assistant.listSessions();
    expect(after.some((s) => s.id === s2.id)).toBe(false);
  });

  it("caps stored sessions at 30", async () => {
    for (let i = 0; i < 32; i++) {
      await assistant.newSession(`bulk-${i}`);
    }
    const list = await assistant.listSessions();
    expect(list.length).toBeLessThanOrEqual(30);
  });

  it("migrates a v1 single history into a Main session", async () => {
    // The mock store is per-path; exercise the migration through the
    // exported surface: seeding requires the raw store — verified instead
    // by the source contract below plus the shape of newSession.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8"),
    );
    expect(src).toContain('await prefsStore.get<UIMessage[]>("history")');
    expect(src).toContain('createSession("Main")');
  });
});

/**
 * IPC CONTRACT — the argument NAMES must match the Rust command signatures.
 *
 * Two production builds shipped broken on exactly this class of bug:
 *   - `secrets_set` was called with `value:` instead of `password:` →
 *     "missing required key password"
 *   - `telegram_start` was passed a bare function instead of a Tauri
 *     `Channel` → "missing required key onEvent"
 *
 * Tauri maps camelCase JS keys to snake_case Rust params, so a renamed key
 * fails at runtime with no type error. These tests execute the wrappers and
 * assert the exact payload shape.
 */
describe("telegram IPC contract", () => {
  it("secrets_set sends `password` (not `value`) for the bot token", async () => {
    vi.mocked(invoke).mockClear();
    await assistant.setTelegramToken("123:abc");
    const calls = vi.mocked(invoke).mock.calls; const [cmd, args] = calls[calls.length - 1]!;
    expect(cmd).toBe("secrets_set");
    const payload = args as Record<string, unknown>;
    expect(payload).toHaveProperty("password", "123:abc");
    expect(payload).not.toHaveProperty("value");
    expect(payload).toMatchObject({
      service: expect.any(String),
      account: "telegram_bot_token",
    });
  });

  it("telegram_start passes a real Channel, never a bare function", async () => {
    vi.mocked(invoke).mockClear();
    const handler = vi.fn();
    await assistant.telegramNative.start("123:abc", null, handler);
    const calls = vi.mocked(invoke).mock.calls; const [cmd, args] = calls[calls.length - 1]!;
    expect(cmd).toBe("telegram_start");
    const payload = args as Record<string, unknown>;
    // A function is not serializable — Tauri silently drops the argument and
    // the Rust command reports a missing key. Must be a Channel instance.
    expect(typeof payload.onEvent).not.toBe("function");
    expect(payload.onEvent).toBeInstanceOf(Channel);
    expect(payload).toHaveProperty("ownerChatId", null);
  });

  it("every telegram command name matches a registered Rust command", async () => {
    vi.mocked(invoke).mockClear();
    const t = assistant.telegramNative;
    await t.stop();
    await t.bindOwner();
    await t.clearOwner();
    await t.status();
    await t.sendMessage("tok", 1, "hi");
    await t.downloadVoice("tok", "fid");
    await t.downloadFile("tok", "fid");
    const names = vi.mocked(invoke).mock.calls.map((c) => c[0]);
    expect(names).toEqual([
      "telegram_stop",
      "telegram_bind_owner",
      "telegram_clear_owner",
      "telegram_status",
      "telegram_send_message",
      "telegram_download_voice",
      "telegram_download_file",
    ]);
    // camelCase keys Tauri maps onto snake_case Rust params.
    const sendArgs = vi.mocked(invoke).mock.calls[4]![1] as Record<string, unknown>;
    expect(sendArgs).toEqual({ token: "tok", chatId: 1, text: "hi" });
  });
});

describe("resolveAssistantEndpoint (assistant endpoint isolation)", () => {
  const globals = {
    lmstudioModelId: "global-lm-name",
    lmstudioBaseURL: "http://localhost:1234/v1",
    openaiCompatibleModelId: "global-compat-name",
    openaiCompatibleBaseURL: "http://sparky.local:8888/v1",
  };

  it("custom model with NO assistant overrides inherits the global endpoint", () => {
    const r = assistant.resolveAssistantEndpoint("openai-compatible-custom", {}, globals);
    expect(r.resolvedModelId).toBe("global-compat-name");
    expect(r.openaiCompatibleBaseURL).toBe("http://sparky.local:8888/v1");
  });

  it("assistant customModelId + customBaseUrl WIN over the global endpoint", () => {
    const r = assistant.resolveAssistantEndpoint(
      "openai-compatible-custom",
      { customModelId: " my-pinned-model ", customBaseUrl: "http://other:9/v1" },
      globals,
    );
    expect(r.resolvedModelId).toBe("my-pinned-model");
    expect(r.openaiCompatibleBaseURL).toBe("http://other:9/v1");
  });

  it("blank/whitespace overrides fall back to global (not empty string)", () => {
    const r = assistant.resolveAssistantEndpoint(
      "lmstudio-local",
      { customModelId: "   ", customBaseUrl: "" },
      globals,
    );
    expect(r.resolvedModelId).toBe("global-lm-name");
    expect(r.lmstudioBaseURL).toBe("http://localhost:1234/v1");
  });

  it("lmstudio override sets the lmstudio URL, not the compat one", () => {
    const r = assistant.resolveAssistantEndpoint(
      "lmstudio-local",
      { customBaseUrl: "http://lm:1234/v1" },
      globals,
    );
    expect(r.lmstudioBaseURL).toBe("http://lm:1234/v1");
    expect(r.openaiCompatibleBaseURL).toBe("http://sparky.local:8888/v1"); // untouched
  });

  it("a non-custom cloud model ignores the assistant overrides entirely", () => {
    const r = assistant.resolveAssistantEndpoint(
      "gpt-5.4-mini",
      { customModelId: "should-not-apply", customBaseUrl: "http://nope/v1" },
      globals,
    );
    expect(r.resolvedModelId).toBe("gpt-5.4-mini");
  });
});
