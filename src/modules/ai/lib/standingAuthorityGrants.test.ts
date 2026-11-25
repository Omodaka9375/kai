import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

/**
 * PER-PROJECT "Always Allow" GRANTS (2026-11-25 security hardening).
 *
 * The grant list used to be one GLOBAL flat list: a "yes" clicked in
 * project A silenced the approval card in every OTHER project too -
 * including freshly cloned / untrusted ones. A permission is trust in a
 * project, so each "yes" must count only where it was given:
 *
 *  - new grants write a per-project map keyed by canonical project id;
 *  - the legacy flat list stays as a fallback for TRUSTED projects only;
 *  - untrusted projects inherit NOTHING.
 *
 * These tests exercise effectiveAuthorityGrants's resolution with a mocked
 * trust registry, and pin the enforcement surfaces (bridge, approval card,
 * group persona gate) so no gate can regress to the global list.
 */

const PID_A = "local:d:/proj/a";
const PID_B = "local:d:/proj/b";

vi.mock("@/modules/workspace/workspaceTrust", () => ({
  isWorkspaceTrusted: (id: string | null | undefined) =>
    id === PID_A || id == null,
}));

vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: {
    getState: () => ({
      standingAuthorityAlwaysAllowed: ["save_memory"],
      standingAuthorityGrantProjects: {
        [PID_B]: ["watch_create"],
      },
    }),
  },
}));

describe("per-project authority grants - resolution", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("a per-project grant counts only in its project", async () => {
    const m = await import("./standingAuthorityGrants");
    // Project B has a scoped watch_create grant...
    expect(
      m.effectiveAuthorityGrants(PID_B, {
        standingAuthorityAlwaysAllowed: ["save_memory"],
        standingAuthorityGrantProjects: { [PID_B]: ["watch_create"] },
      }),
    ).toEqual(["watch_create"]);
    // ...and it does NOT leak into project A.
    expect(
      m.effectiveAuthorityGrants(PID_A, {
        standingAuthorityAlwaysAllowed: ["save_memory"],
        standingAuthorityGrantProjects: { [PID_B]: ["watch_create"] },
      }),
    ).toEqual(["save_memory"]); // legacy fallback (trusted)
  });

  it("the legacy flat list never covers an UNTRUSTED project", async () => {
    const m = await import("./standingAuthorityGrants");
    // PID_A is trusted in this mock; PID_B has a map entry so it never
    // reads the legacy list. Use a third, untrusted project id to test
    // the legacy fallback's trust gate.
    expect(
      m.effectiveAuthorityGrants("local:d:/shady/clone", {
        standingAuthorityAlwaysAllowed: ["save_memory", "mcp_add_server"],
        standingAuthorityGrantProjects: {},
      }),
    ).toEqual([]); // untrusted -> NOTHING inherited
  });

  it("trusted projects with no map entry keep the legacy grants (no user breakage)", async () => {
    const m = await import("./standingAuthorityGrants");
    expect(
      m.effectiveAuthorityGrants(PID_A, {
        standingAuthorityAlwaysAllowed: ["save_memory"],
        standingAuthorityGrantProjects: {},
      }),
    ).toEqual(["save_memory"]);
  });

  it("no project (rootless surface) reads no per-project grants and no legacy leak", async () => {
    const m = await import("./standingAuthorityGrants");
    // Rootless surfaces resolve their own way (personas read the legacy
    // list directly); effectiveAuthorityGrants deliberately returns []
    // for no-project so callers must opt into the flat list explicitly.
    expect(
      m.effectiveAuthorityGrants(null, {
        standingAuthorityAlwaysAllowed: ["save_memory"],
        standingAuthorityGrantProjects: { [PID_B]: ["watch_create"] },
      }),
    ).toEqual([]);
  });

  it("hasStandingAuthorityGrant checks the project's effective list", async () => {
    const m = await import("./standingAuthorityGrants");
    const snapshot = {
      standingAuthorityAlwaysAllowed: ["save_memory"],
      standingAuthorityGrantProjects: { [PID_B]: ["watch_create"] },
    };
    // Granted IN B, not in A.
    expect(m.hasStandingAuthorityGrant("watch_create", snapshot, PID_B)).toBe(true);
    expect(m.hasStandingAuthorityGrant("watch_create", snapshot, PID_A)).toBe(false);
    // Legacy grant counts in trusted A, but not in untrusted shady/.
    expect(m.hasStandingAuthorityGrant("save_memory", snapshot, PID_A)).toBe(true);
    expect(
      m.hasStandingAuthorityGrant("save_memory", snapshot, "local:d:/shady/clone"),
    ).toBe(false);
  });
});

describe("per-project authority grants - enforcement surfaces", () => {
  it("the bridge resolves grants for ITS project (schedule + fire time)", () => {
    const bridge = readFileSync(
      new URL("../components/AgentRunBridge.tsx", import.meta.url),
      "utf8",
    );
    // Schedule-time: the hook selector resolves the project-scoped list.
    expect(bridge).toContain("effectiveAuthorityGrants(grantsProjectId, {");
    expect(bridge).toContain("const grantsProjectId =");
    // Fire-time re-check also resolves per project.
    expect(bridge).toMatch(/effectiveAuthorityGrants\(grantsProjectId\),/);
    // The bridge no longer feeds the raw global list to any gate.
    expect(bridge).not.toContain("(s) => s.standingAuthorityAlwaysAllowed");
  });

  it("the approval card grants, predicts, and checks per project", () => {
    const card = readFileSync(
      new URL("../components/AiToolApproval.tsx", import.meta.url),
      "utf8",
    );
    // Prediction input is the project-scoped list.
    expect(card).toContain("effectiveAuthorityGrants(projectIdForSession(ownerSessionId), {");
    // The Always Allow button writes the owning project's grant.
    expect(card).toMatch(/grantStandingAuthorityAlwaysAllow\(\s*toolName,\s*projectIdForSession\(ownerSessionId\),/);
    // The flat-row check passes the project.
    expect(card).toMatch(/hasStandingAuthorityGrant\(\s*toolName,/);
  });

  it("persona (group) runs read ONLY the legacy flat list - never a project's grants", () => {
    const group = readFileSync(
      new URL("../store/groupChatStore.ts", import.meta.url),
      "utf8",
    );
    // The persona gate must not resolve any project's scoped grants:
    // personas have no project, a project grant must never cover them.
    expect(group).toContain(".standingAuthorityAlwaysAllowed,");
  });
});
