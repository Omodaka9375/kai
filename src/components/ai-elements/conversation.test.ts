import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const conversation = readFileSync(new URL("./conversation.tsx", import.meta.url), "utf8");
const miniWindow = readFileSync(
  new URL("../../modules/ai/components/AiMiniWindow.tsx", import.meta.url),
  "utf8",
);

describe("restored conversation scrolling", () => {
  it("lands on the current line immediately instead of replaying a smooth scroll", () => {
    expect(conversation).toContain('initial="instant"');
    expect(conversation).toContain('resize="instant"');
    expect(conversation).not.toContain('initial="smooth"');
    expect(conversation).not.toContain('resize="smooth"');
  });

  it("keeps the mini-window mounted when its workspace switches visibility", () => {
    const app = readFileSync(new URL("../../app/App.tsx", import.meta.url), "utf8");
    // 2026-11-02 round 2: the mini-window/pill mount condition lives in the
    // ActiveSurfaces gate component (context-subscribed) instead of inline
    // in the workspace body - a body-level isActive read re-rendered the
    // whole tree on every project switch.
    expect(app).toContain("function ActiveSurfaces");
    // No session key on the animated window: changing sessions reuses the
    // same conversation surface rather than restarting an enter animation.
    expect(miniWindow).not.toContain('<AiMiniWindow key={sessionId}');
  });
});
