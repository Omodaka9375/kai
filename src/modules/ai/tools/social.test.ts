import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSocialTools,
  primeXBearerPresence,
  setXBearer,
  clearXBearer,
  xBearerKnownAbsent,
} from "./social";

/**
 * The unconfigured-X prune contract: when the user has never set an X
 * bearer token, the social_read tool must NOT be in the agent's toolset at
 * all, and the module must say so. The failure mode this pins: models kept
 * calling social_read, burning a step on "X is not configured" before
 * falling back to web_search.
 */

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

// buildSocialTools ignores its ctx; a typed stub satisfies the signature.
const ctxStub = {} as unknown as import("./context").ToolContext;
const B = () => buildSocialTools(ctxStub) as Record<string, unknown>;

/** Simulate the keychain: one string slot for the bearer account. */
let bearer: string | null = null;

function keychainInvoke() {
  return async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "secrets_get" && args.account === "x-bearer-token") return bearer;
    if (cmd === "secrets_set" && args.account === "x-bearer-token") {
      bearer = String(args.password);
      return null;
    }
    if (cmd === "secrets_delete" && args.account === "x-bearer-token") {
      bearer = null;
      return null;
    }
    return null;
  };
}

describe("social_read prune when X unconfigured", () => {
  beforeEach(() => {
    bearer = null;
    invokeMock.mockReset();
    invokeMock.mockImplementation(keychainInvoke());
  });

  it("primed-absent → no social_read tool, and the absence flag is set", async () => {
    await primeXBearerPresence();
    expect(xBearerKnownAbsent()).toBe(true);
    const tools = B();
    expect(Object.keys(tools)).not.toContain("social_read");
    expect(Object.keys(tools)).toEqual([]);
  });

  it("unprimed (fresh boot before first run) keeps the tool — safety default", async () => {
    // Reset the module cache to simulate a process that never primed.
    bearer = null;
    vi.resetModules();
    const fresh = await import("./social");
    expect(fresh.xBearerKnownAbsent()).toBe(false);
    const tools = fresh.buildSocialTools(ctxStub);
    expect(Object.keys(tools)).toContain("social_read");
  });

  it("primed-present keeps the tool", async () => {
    await setXBearer("token-abc");
    await primeXBearerPresence();
    expect(xBearerKnownAbsent()).toBe(false);
    const tools = B();
    expect(Object.keys(tools)).toContain("social_read");
  });

  it("clearing the token flips the cache so the next build omits the tool", async () => {
    await setXBearer("token-abc");
    await primeXBearerPresence();
    await clearXBearer();
    expect(xBearerKnownAbsent()).toBe(true);
    const tools = B();
    expect(Object.keys(tools)).not.toContain("social_read");
  });
});
