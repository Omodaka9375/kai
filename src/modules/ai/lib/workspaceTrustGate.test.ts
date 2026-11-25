import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * WORKSPACE TRUST GATE (2026-11-25) - source pins for every approval
 * surface. A cloned repo ships agent instructions (KAI.md, .kai/rules,
 * MEMORY.md, skill bodies ride the system prompt); the trust gate forces
 * Ask for projects the user has not vouched for. These pins make sure NO
 * approval-resolution path can read the RAW stored mode where the gate
 * should apply - a new surface that reads `getSessionAutoApprove(` for a
 * gating decision (display-only reads excepted) must route through
 * `effectiveSessionAutoApprove` instead.
 */

const bridge = readFileSync(
  new URL("../components/AgentRunBridge.tsx", import.meta.url),
  "utf8",
);
const transport = readFileSync(new URL("./transport.ts", import.meta.url), "utf8");
const chatStore = readFileSync(new URL("../store/chatStore.ts", import.meta.url), "utf8");
const approvalCard = readFileSync(
  new URL("../components/AiToolApproval.tsx", import.meta.url),
  "utf8",
);
const grid = readFileSync(
  new URL("../components/ProjectChatGrid.tsx", import.meta.url),
  "utf8",
);
const todoStrip = readFileSync(
  new URL("../components/TodoStrip.tsx", import.meta.url),
  "utf8",
);
const mini = readFileSync(
  new URL("../components/AiMiniWindow.tsx", import.meta.url),
  "utf8",
);
const rail = readFileSync(
  new URL("../../../modules/workspace/ProjectRail.tsx", import.meta.url),
  "utf8",
);
const trustStore = readFileSync(
  new URL("../../../modules/workspace/workspaceTrust.ts", import.meta.url),
  "utf8",
);
const appShell = readFileSync(
  new URL("../../../app/AppShell.tsx", import.meta.url),
  "utf8",
);

describe("workspace trust gate - enforcement surfaces", () => {
  it("chatStore exposes effectiveSessionAutoApprove gated on workspace trust", () => {
    expect(chatStore).toContain("export function effectiveSessionAutoApprove(");
    // The gate consults the trust registry.
    expect(chatStore).toContain("isWorkspaceTrusted(projectIdForSession(sessionId))");
  });

  it("the bridge auto-approve effect gates on the EFFECTIVE mode (both schedule and fire time)", () => {
    // Schedule-time memo ...
    expect(bridge).toContain("effectiveSessionAutoApprove(sessionId)");
    // ... and the fire-time re-check inside the setTimeout.
    expect(bridge).toMatch(/effectiveSessionAutoApprove\(sessionId\) !== "all"/);
    // No raw mode read remains in the bridge.
    expect(bridge).not.toContain("getSessionAutoApprove(sessionId)");
  });

  it("the auto-approve PROMPT hint reflects the effective mode", () => {
    expect(transport).toContain("effectiveSessionAutoApprove(sessionIdForRun)");
  });

  it("untrusted projects get the <untrusted-project> prompt notice over repo rules", () => {
    expect(transport).toContain("<untrusted-project>");
    expect(transport).toContain("isWorkspaceTrusted(projectIdForTrust)");
  });

  it("the approval card predicts with the effective mode (no flat-row blink)", () => {
    expect(approvalCard).toContain("effectiveSessionAutoApprove(ownerSessionId)");
    expect(approvalCard).not.toContain("predictAutoApproval({\n      autoApprove: sessionAutoApprove,\n      toolName,\n      input,\n      signingApprovalRequired,\n      alwaysAllowedAuthorityTools: authorityGrants,\n    });\n  }\n  // ALWAYS-ALLOW GRANT (2026-11-16)");
  });

  it("Workspaces pill and TodoStrip paint the effective mode", () => {
    expect(grid).toContain("const mode = effectiveSessionAutoApprove(sessionId);");
    expect(todoStrip).toContain('effectiveSessionAutoApprove(sessionId ?? "")');
  });
});

describe("workspace trust gate - user surfaces", () => {
  it("TrustStrip banners untrusted projects with a one-click Trust button", () => {
    const strip = readFileSync(
      new URL("../components/TrustStrip.tsx", import.meta.url),
      "utf8",
    );
    expect(strip).toContain("Trust this project");
    expect(strip).toContain("isWorkspaceTrustHydrated()");
    // Mounted in the AI window body, above the transcript.
    expect(mini).toContain("<TrustStrip />");
  });

  it("Workspaces cards carry their own per-project trust banner", () => {
    // The grid shows many projects at once - the active-project strip
    // cannot cover untrusted BACKGROUND projects. Each card must mount
    // the per-card variant with its own Trust button.
    expect(grid).toContain("<CardTrustStrip projectId={projectId} />");
    const strip = readFileSync(
      new URL("../components/TrustStrip.tsx", import.meta.url),
      "utf8",
    );
    expect(strip).toContain("export function CardTrustStrip({ projectId }: { projectId: string })");
    expect(strip).toContain("trustWorkspace(projectId)");
  });

  it("the rail tile context menu can trust and untrust", () => {
    expect(rail).toContain("Trust project");
    expect(rail).toContain("Untrust project");
    expect(rail).toContain("untrustWorkspace(project.id)");
  });

  it("AppShell seeds the trust registry at boot with the open projects", () => {
    expect(appShell).toContain("hydrateWorkspaceTrust(initial.map((p) => p.id))");
  });

  it("the registry persists per-project trust with a first-run migration marker", () => {
    expect(trustStore).toContain("migrated");
    expect(trustStore).toContain("kai-workspace-trust.json");
    // Fail-closed for known projects, fail-open for NO project.
    expect(trustStore).toContain("if (!projectId) return true;");
  });
});
