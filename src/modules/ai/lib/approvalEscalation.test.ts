import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * SOURCE PINS (2026-11-26 report: "models get stuck at Run shell command
 * approving… when allow mode is approved already - yellow indicator, run
 * not running, doesn't remember running the command, clicking approve
 * doesn't work").
 *
 * Field evidence (audit.jsonl): the same bash_run approval recorded THREE
 * approval.approve entries within ~600ms - the user clicking Approve over
 * and over because the card never reacted.
 *
 * Root cause chain, traced from source + the ai@6.0.168 dist:
 *  1. In Allow mode the card renders a PREDICTED flat row ("approving…",
 *     amber pulsing dot, NO buttons) trusting the bridge to resolve the
 *     call within a macrotask.
 *  2. The bridge's deferred respond() can miss (part not found yet in the
 *     throttled messages snapshot, or a latch from a reaper pass), and on
 *     a PARKED run nothing re-runs the auto-approve effect - so the
 *     prediction was wrong forever and the row was a permanent dead end.
 *  3. The escalation contract below is the fix: the card degrades the
 *     prediction to the full interactive card after a grace window, and
 *     the bridge retries a failed deferred approval a bounded number of
 *     times with the same fire-time gates.
 */
describe("stuck-approving approval escalation (2026-11-26)", () => {
  const card = readFileSync(
    new URL("../components/AiToolApproval.tsx", import.meta.url),
    "utf8",
  );
  const bridge = readFileSync(
    new URL("../components/AgentRunBridge.tsx", import.meta.url),
    "utf8",
  );

  it("a predicted flat row escalates to the interactive card after a grace window", () => {
    // The prediction is time-boxed: after PREDICTION_GRACE_MS with no
    // markAutoApproved, the full card (Approve/Deny buttons) must render.
    // Without this, a wrong prediction was an unanswerable dead end.
    expect(card).toContain("PREDICTION_GRACE_MS");
    expect(card).toContain("predictionStale");
    // The grace timer only runs while the prediction is live and the
    // decision has not landed.
    expect(card).toMatch(
      /if \(!predictedAutoApproval \|\| wasAutoApproved \|\| hasGrant\) return;/,
    );
    // The flat-row gate consumes the STALE-aware prediction, so the
    // escalation flips the render, not just a label.
    expect(card).toContain(
      "const willBeAutoApproved = predictedAutoApproval && !predictionStale;",
    );
    expect(card).toContain(
      "if (wasAutoApproved || willBeAutoApproved || hasGrant) {",
    );
  });

  it("the escalation timer resets per approval id and lands via autoApprovedIds", () => {
    // Keyed on the approval id: a re-bound card (session switch) must not
    // inherit another approval's stale flag, and the resolution path is the
    // reactive autoApprovedIds subscription (wasAutoApproved), which cancels
    // the timer through the re-render.
    expect(card).toMatch(/const approvalId = part\.approval\.id;/);
    expect(card).toContain("approvalId, predictedAutoApproval, wasAutoApproved, hasGrant");
  });

  it("the bridge retries a failed deferred auto-approve with bounded backoff", () => {
    // The old contract - "the next effect pass retries it" - is false on a
    // parked run. The retry must exist, be bounded, and re-run the
    // fire-time gates so a Deny or a mode flip mid-retry still wins.
    expect(bridge).toContain("retryAutoApproveRef.current(id, toolName, 1);");
    expect(bridge).toMatch(/if \(attempt < 4\) retryAutoApproveRef\.current/);
    expect(bridge).toMatch(/const delay = 100 \* attempt;/);
    // The retry path re-checks the effective mode and the per-project
    // grants, exactly like the original deferred timer.
    const retry = bridge.slice(
      bridge.indexOf("retryAutoApproveRef.current = (id, toolName, attempt) => {"),
      bridge.indexOf("// ---- AI diff tab management"),
    );
    expect(retry).toContain('effectiveSessionAutoApprove(sessionId) !== "all"');
    expect(retry).toContain("isAlwaysAllowedAuthorityTool");
    expect(retry).toContain("effectiveAuthorityGrants(grantsProjectId)");
  });

  it("the retry only fires from a FAILED respond, never latches a phantom", () => {
    // The retry arms ONLY in the else branch of a failed respond, and the
    // success path (latch + markAutoApproved) is unchanged.
    const effect = bridge.slice(
      bridge.indexOf("if (respond(id, true)) {"),
      bridge.indexOf("}, 0);"),
    );
    expect(effect).toContain("autoApprovedRef.current.add(id)");
    expect(effect).toContain("markAutoApproved(id)");
    expect(effect).toContain("retryAutoApproveRef.current(id, toolName, 1)");
  });

  it("a latch-dropped Approve surfaces a console warn instead of silence", () => {
    // The monotonic latch stays (denials must never be re-permitted), but a
    // human Approve silently no-opping read as "the button is broken".
    // The store's standalone responder (the human-click path) now warns.
    const store = readFileSync(
      new URL("../store/chatStore.ts", import.meta.url),
      "utf8",
    );
    expect(store).toMatch(
      /if \(approved && isApprovalDenied\(approvalId\)\) \{/,
    );
    expect(store).toContain("approve dropped - this call was already denied earlier");
  });
});
