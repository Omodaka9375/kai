import { describe, expect, it } from "vitest";
import { hasLeakedToolCall } from "./leakedToolCall";

describe("hasLeakedToolCall", () => {
  it("detects angle-bracket template tokens", () => {
    expect(hasLeakedToolCall('<|tool_call:read_file|>{"path":"a.ts"}')).toBe(true);
    expect(hasLeakedToolCall("<|tool_call|>")).toBe(true);
    expect(hasLeakedToolCall("<tool_call>read_file</tool_call>")).toBe(true);
  });

  it("detects call:fn{...} channel syntax", () => {
    expect(hasLeakedToolCall('call:read_file{"path":"a.ts"}')).toBe(true);
  });

  it("detects raw JSON payloads with edit keys", () => {
    expect(hasLeakedToolCall('{"old_string": <|"|>a<|"|>, "new_string": <|"|>b<|"|>}')).toBe(true);
    expect(hasLeakedToolCall('{"proposedContent": <|"|>x<|"|>}')).toBe(true);
  });

  it("detects <|\"|> delimiter with path key", () => {
    expect(hasLeakedToolCall('{"path": <|"|>src/a.ts<|"|>}')).toBe(true);
  });

  it("detects raw JSON function-call blobs", () => {
    expect(
      hasLeakedToolCall('{"name": "read_file", "arguments": {"path": "a.ts"}}'),
    ).toBe(true);
    expect(
      hasLeakedToolCall('{"name":"bash_run","parameters":{"command":"ls"}}'),
    ).toBe(true);
  });

  it("detects antml-style invokes", () => {
    expect(
      hasLeakedToolCall(
        '<invoke name="read_file"><parameter name="path">a.ts</parameter></invoke>',
      ),
    ).toBe(true);
  });

  it("does not flag normal prose", () => {
    expect(hasLeakedToolCall("I'll read the file now.")).toBe(false);
    expect(hasLeakedToolCall("The function `read_file` is defined in fs.ts.")).toBe(false);
    expect(hasLeakedToolCall('Use {"path": "a.ts"} as the argument.')).toBe(false);
    expect(hasLeakedToolCall("")).toBe(false);
  });

  it("does not flag code snippets mentioning tools", () => {
    expect(
      hasLeakedToolCall("const tools = { read_file: tool({ description: 'Read' }) };"),
    ).toBe(false);
  });
});
