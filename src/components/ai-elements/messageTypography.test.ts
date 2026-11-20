import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * CHAT TYPOGRAPHY + WRAP CONTRACT (2026-11-20 ask): "any generated text
 * block or code or table text is bigger than normal - the font size must
 * be proportional in AI window and project chat card alike" and "in
 * Workspaces mode all gen box, text, code etc block is not wrapped
 * horizontally".
 *
 * Two independent defects, both pinned here:
 *  1. SIZE: Streamdown ships text-sm (14px) on table cells, inline code
 *     and h5/h6 - larger than the 12px chat body, so tables and snippets
 *     read as oversized blocks.
 *  2. WRAP: the transcript used the class `overflow-wrap-anywhere`, which
 *     does NOT exist in Tailwind v4 (the real utility is `wrap-anywhere`).
 *     It was a silent no-op, so long tokens never wrapped and wide blocks
 *     inflated the narrow Workspaces cards instead of scrolling inside.
 */

const message = readFileSync(new URL("./message.tsx", import.meta.url), "utf8");
const table = readFileSync(new URL("./chat-table.tsx", import.meta.url), "utf8");
const aiChat = readFileSync(
  new URL("../../modules/ai/components/AiChat.tsx", import.meta.url),
  "utf8",
);

describe("chat block typography is proportional to the 12px body", () => {
  it("table cells are pinned to the body scale, not Streamdown's text-sm", () => {
    expect(message).toContain("[&_th]:text-[12px]");
    expect(message).toContain("[&_td]:text-[12px]");
    expect(message).toContain("[&_table]:text-[12px]");
  });

  it("inline code, sup/sub and h5/h6 are pinned to the body scale", () => {
    expect(message).toContain("[&_code]:text-[11px]");
    expect(message).toContain("[&_sup]:text-[10px]");
    expect(message).toContain("[&_sub]:text-[10px]");
    expect(message).toContain("[&_h5]:text-[12px]");
    expect(message).toContain("[&_h6]:text-[12px]");
  });
});

describe("wide blocks wrap or scroll instead of widening the card", () => {
  it("uses the real Tailwind v4 wrap utility (overflow-wrap-anywhere does not exist)", () => {
    expect(message).toContain("wrap-anywhere");
    // The dead class must never come back - it silently does nothing.
    expect(message).not.toContain("overflow-wrap-anywhere");
  });

  it("wide blocks are width-capped so they cannot inflate the transcript", () => {
    expect(message).toContain("[&_table]:max-w-full");
    expect(message).toContain("[&_ul]:max-w-full");
    expect(message).toContain("[&_ol]:max-w-full");
    // The table wrapper is a data attribute, not a custom element: the
    // plain `[&_table-wrapper]` form compiles to an element selector that
    // matches nothing (dead CSS).
    expect(message).toContain("[&_[data-streamdown=table-wrapper]]:max-w-full");
    expect(message).not.toContain("[&_table-wrapper]");
  });

  it("the table wrapper is a min-w-0 flex child with its own scroller", () => {
    // min-w-0 lets the wrapper shrink below its intrinsic content width;
    // without it a wide table inflates every ancestor (the card clips).
    expect(table).toContain("flex min-w-0 max-w-full flex-col");
    expect(table).toContain("min-w-0 max-w-full overflow-x-auto");
  });

  it("the transcript scroller itself carries min-w-0", () => {
    expect(aiChat).toContain('cn("min-w-0 gap-5 p-3 pb-6", contentClassName)');
    expect(aiChat).toContain('<ConversationContent className="min-w-0"');
  });
});
