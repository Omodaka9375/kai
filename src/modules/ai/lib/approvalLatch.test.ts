import { afterEach, describe, expect, it } from "vitest";
import {
  __resetApprovalLatchForTests,
  isApprovalDenied,
  noteApprovalDenied,
} from "./approvalLatch";

/**
 * Denial-latch tests. The whole point is ORDER-INDEPENDENCE: once an id is
 * denied, nothing can re-permit it, and the deferred auto-approve callbacks
 * (which fire after a human Deny in the race this fixes) consult the latch at
 * fire time.
 */

describe("approvalLatch", () => {
  afterEach(() => __resetApprovalLatchForTests());

  it("records a denial and answers it", () => {
    expect(isApprovalDenied("a1")).toBe(false);
    noteApprovalDenied("a1");
    expect(isApprovalDenied("a1")).toBe(true);
  });

  it("denial is sticky — repeat notes are idempotent", () => {
    noteApprovalDenied("a2");
    noteApprovalDenied("a2");
    expect(isApprovalDenied("a2")).toBe(true);
  });

  it("scopes per-id: denying one does not deny another", () => {
    noteApprovalDenied("a3");
    expect(isApprovalDenied("a3")).toBe(true);
    expect(isApprovalDenied("a4")).toBe(false);
  });

  it("ignores the empty id (never latches a wildcard)", () => {
    noteApprovalDenied("");
    expect(isApprovalDenied("")).toBe(false);
  });

  it("stays bounded (FIFO eviction) without corrupting recent entries", () => {
    for (let i = 0; i < 1100; i++) noteApprovalDenied(`id-${i}`);
    // The most recent denials survive the 1000-cap.
    expect(isApprovalDenied("id-1099")).toBe(true);
    expect(isApprovalDenied("id-1050")).toBe(true);
    // The oldest ones were evicted (bounded memory), which is safe by design.
    expect(isApprovalDenied("id-0")).toBe(false);
  });
});
