/**
 * Shared detection for leaked tool-call markup in model text output.
 *
 * Small/local models (Gemma, Qwen, Mistral-instruct variants, LM Studio
 * customs) sometimes emit their tool-call template as plain text instead of
 * a structured function call — e.g. `<|tool_call:read_file|>`, `<tool_call>`,
 * or a raw `{"name": "...", "arguments": {...}}` JSON blob. The stream then
 * ends with zero real tool parts and the agent appears to "stop mid-task".
 *
 * Two consumers:
 *  - AiChat strips these tokens for display (`stripLeakedTokens`).
 *  - AgentRunBridge uses `hasLeakedToolCall` to decide whether to auto-nudge
 *    the model with a "use native function calling" correction.
 */

/** Heuristic: does this text contain leaked tool-call markup? */
export function hasLeakedToolCall(text: string): boolean {
  if (!text) return false;
  // Angle-bracket template tokens: <|tool_call…, <|tool_call:…, <tool_call>
  if (/<\|?\s*tool[_-]?calls?/i.test(text)) return true;
  // Function-call channel syntax: call:fn_name{...}
  if (/\bcall:[a-z_][a-z0-9_]*\s*\{/i.test(text)) return true;
  // Raw JSON payload with tool-ish argument keys and <|… delimiters
  if (
    /(?:new_string|old_string|proposedContent|proposed_content)"?\s*:\s*<\|/.test(
      text,
    )
  )
    return true;
  if (text.includes('<|"|>') && /"?(?:path|command)"?\s*:/.test(text))
    return true;
  // Raw JSON function-call blob: {"name": "read_file", "arguments"/"parameters": {...}}
  if (
    /\{\s*"name"\s*:\s*"[a-z_][a-z0-9_]*"\s*,\s*"(?:arguments|parameters|input|args)"\s*:/i.test(
      text,
    )
  )
    return true;
  // Anthropic-style antml invokes
  if (/<\s*(?:antml:)?invoke\b/i.test(text) && /<\s*(?:antml:)?parameter\b/i.test(text))
    return true;
  return false;
}
