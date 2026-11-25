import { beforeEach, describe, expect, it, vi } from "vitest";

const writes = vi.hoisted(() => vi.fn());
const storeMap = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: vi.fn().mockImplementation(() => ({
    get: vi.fn(async (key: string) => storeMap.get(key)),
    set: writes.mockImplementation(async (key: string, value: unknown) => {
      storeMap.set(key, value);
    }),
    save: vi.fn(),
  })),
}));

const PID_A = "local:d:/code/2026/project-a";
const PID_B = "wsl:ubuntu:/home/u/project-b";

/**
 * The 2026-11-25 trust model: a repo ships agent INSTRUCTIONS via KAI.md /
 * .kai rules / MEMORY.md. Direct execution on open is already impossible;
 * this registry closes the INDIRECT path by forcing Ask for projects the
 * user has not vouched for.
 *
 * Module state (trusted set, hydration memo) is module-scoped, so each test
 * re-imports a FRESH module instance via vi.resetModules() + dynamic import.
 */
async function freshModule() {
  vi.resetModules();
  return import("./workspaceTrust");
}

describe("workspace trust registry", () => {
  beforeEach(() => {
    storeMap.clear();
    writes.mockClear();
  });

  it("first run seeds every open project trusted (no surprise banners)", async () => {
    const m = await freshModule();
    await m.hydrateWorkspaceTrust([PID_A, PID_B]);
    expect(m.isWorkspaceTrusted(PID_A)).toBe(true);
    expect(m.isWorkspaceTrusted(PID_B)).toBe(true);
    // Migration marker persisted so later boots don't re-seed.
    expect(writes).toHaveBeenCalledWith(
      "trust",
      expect.objectContaining({ migrated: true, trusted: [PID_A, PID_B] }),
    );
  });

  it("after the marker, a project opened later is UNTRUSTED until the user trusts it", async () => {
    const m = await freshModule();
    await m.hydrateWorkspaceTrust([PID_A]);
    const pidC = "local:d:/code/2026/cloned-unknown-repo";
    expect(m.isWorkspaceTrusted(pidC)).toBe(false);
    m.trustWorkspace(pidC);
    expect(m.isWorkspaceTrusted(pidC)).toBe(true);
    // And persists in the file.
    expect(writes).toHaveBeenCalledWith(
      "trust",
      expect.objectContaining({ trusted: expect.arrayContaining([pidC]) }),
    );
  });

  it("an existing trust file hydrates without reseeding (migrated marker)", async () => {
    storeMap.set("trust", { migrated: true, trusted: [PID_A] });
    const m = await freshModule();
    await m.hydrateWorkspaceTrust([PID_A, PID_B]);
    expect(m.isWorkspaceTrusted(PID_A)).toBe(true);
    // PID_B was NOT in the file - the migration marker means no seeding.
    expect(m.isWorkspaceTrusted(PID_B)).toBe(false);
  });

  it("untrust reverses a trust decision and notifies subscribers", async () => {
    const m = await freshModule();
    const listener = vi.fn();
    const unsubscribe = m.subscribeWorkspaceTrust(listener);
    m.trustWorkspace(PID_A);
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    m.untrustWorkspace(PID_A);
    expect(m.isWorkspaceTrusted(PID_A)).toBe(false);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it("rootless sessions (no project id) count as trusted - nothing to distrust", async () => {
    const m = await freshModule();
    expect(m.isWorkspaceTrusted(null)).toBe(true);
    expect(m.isWorkspaceTrusted(undefined)).toBe(true);
  });

  it("trustedProjects lists every trusted id for Settings/diagnostics", async () => {
    const m = await freshModule();
    m.trustWorkspace(PID_A);
    expect(m.trustedProjects()).toContain(PID_A);
  });

  it("isWorkspaceTrustHydrated is false before hydration (banner defers)", async () => {
    const m = await freshModule();
    expect(m.isWorkspaceTrustHydrated()).toBe(false);
    await m.hydrateWorkspaceTrust([PID_A]);
    expect(m.isWorkspaceTrustHydrated()).toBe(true);
  });

  it("storage failure degrades to trusting the open projects (no blanket Ask)", async () => {
    // "Don't break existing projects": if the store cannot be read, every
    // project must NOT read untrusted (Allow users silently stuck in Ask
    // with no banner). The open projects are trusted in-memory and the
    // registry marks itself hydrated so the UI functions.
    vi.resetModules();
    storeMap.clear();
    vi.doMock("@tauri-apps/plugin-store", () => ({
      LazyStore: vi.fn().mockImplementation(() => ({
        get: vi.fn(async () => {
          throw new Error("disk wedged");
        }),
        set: vi.fn(async () => {
          throw new Error("disk wedged");
        }),
        save: vi.fn(),
      })),
    }));
    const broken = await import("./workspaceTrust");
    await broken.hydrateWorkspaceTrust([PID_A, PID_B]);
    expect(broken.isWorkspaceTrustHydrated()).toBe(true);
    expect(broken.isWorkspaceTrusted(PID_A)).toBe(true);
    expect(broken.isWorkspaceTrusted(PID_B)).toBe(true);
    // A project NOT in the open set still reads untrusted.
    expect(broken.isWorkspaceTrusted("local:x:/elsewhere")).toBe(false);
    vi.doUnmock("@tauri-apps/plugin-store");
  });
});
