/**
 * DSML (DeepSeek Markup Language) stream middleware.
 *
 * DeepSeek V4 models emit tool calls using a DSML XML format where the
 * namespace prefix varies across providers / prompt templates:
 *
 *   __ variant:      <__tool_calls><__invoke name="edit">...
 *   |DSML| variant:  <|DSML|tool_calls><|DSML|invoke name="edit">...
 *   &#95;&#95;:     <&#95;&#95;tool_calls>... (HTML entities)
 *
 * When routed through providers that don't convert DSML into structured
 * OpenAI-format tool_calls (notably OpenRouter), the stream ends with
 * finishReason: stop and zero tool calls — the agent silently stops
 * mid-thinking.
 *
 * STRATEGY: Instead of trying to enumerate every possible namespace
 * character/encoding, we use **structural** tag matching. Any opening
 * tag `<PREFIXinvoke name="...">` with its matching `</PREFIXinvoke>`
 * closing tag is parsed — regardless of what PREFIX is. Same for
 * `tool_calls` wrappers and `parameter` tags. This catches `__`,
 * `|DSML|`, `&#95;&#95;`, and any future variant without a code change.
 */

import { generateId, type LanguageModelMiddleware } from "ai";

// ── Types ──────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Part = any;

type DsmlToolCall = {
  toolName: string;
  arguments: Record<string, unknown>;
};

// ── Structural DSML parser ─────────────────────────────────────────────────
//
// We don't try to enumerate namespaces. Instead we look for the STRUCTURE:
//
//   <PREFIX tool_calls>          → tool-calls block marker
//   </PREFIX tool_calls>         → tool-calls block closer
//   <PREFIX invoke name="X">     → invoke tag
//   </PREFIX invoke>             → invoke closer
//   <PREFIX parameter name="K" string="B">V</PREFIX parameter>
//
// Where PREFIX is 1-20 non-whitespace, non-`>` characters.

const TOOL_CALLS_OPEN_RE = /<([^\s>]{1,20})tool_calls\s*>/g;
const INVOKE_OPEN_RE = /<([^\s>]{1,20})invoke\s+name\s*=\s*"([^"]+)"\s*>/gs;
const PARAM_RE = /<([^\s>]{1,20})parameter\s+name\s*=\s*"([^"]+)"\s+string\s*=\s*"(true|false)"\s*>([\s\S]*?)<\/\1parameter>/gs;

/**
 * Given a namespace prefix like "__" or "|DSML|", build the literal
 * closing tag and find it in text from startPos.
 */
function findClosingTag(
  text: string,
  prefix: string,
  tag: string,
  startPos: number,
): number {
  const closer = "</" + prefix + tag + ">";
  return text.indexOf(closer, startPos);
}

/** Extract tool calls from raw model text containing DSML fragments. */
export function parseDsmlToolCalls(text: string): DsmlToolCall[] {
  const calls: DsmlToolCall[] = [];

  // Step 1: Find all <PREFIXtool_calls> blocks.
  TOOL_CALLS_OPEN_RE.lastIndex = 0;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = TOOL_CALLS_OPEN_RE.exec(text)) !== null) {
    const prefix = blockMatch[1];
    const blockStart = blockMatch.index + blockMatch[0].length;
    const blockEnd = findClosingTag(text, prefix, "tool_calls", blockStart);
    if (blockEnd === -1) continue;

    const block = text.slice(blockStart, blockEnd);
    parseInvokesInBlock(block, prefix, calls);

    // Advance past this block.
    TOOL_CALLS_OPEN_RE.lastIndex = blockEnd + prefix.length + 14;
  }

  // Step 2: If no tool_calls wrapper found, look for bare invoke tags.
  if (calls.length === 0) {
    INVOKE_OPEN_RE.lastIndex = 0;
    let invokeMatch: RegExpExecArray | null;
    while ((invokeMatch = INVOKE_OPEN_RE.exec(text)) !== null) {
      const prefix = invokeMatch[1];
      const toolName = invokeMatch[2];
      const bodyStart = invokeMatch.index + invokeMatch[0].length;
      const bodyEnd = findClosingTag(text, prefix, "invoke", bodyStart);
      if (bodyEnd === -1) continue;

      const paramsBody = text.slice(bodyStart, bodyEnd);
      const args = parseParams(paramsBody, prefix);
      calls.push({ toolName, arguments: args });
    }
  }

  return calls;
}

function parseInvokesInBlock(
  block: string,
  prefix: string,
  out: DsmlToolCall[],
): void {
  INVOKE_OPEN_RE.lastIndex = 0;
  let invokeMatch: RegExpExecArray | null;

  while ((invokeMatch = INVOKE_OPEN_RE.exec(block)) !== null) {
    const invokePrefix = invokeMatch[1];
    if (invokePrefix !== prefix) continue;

    const toolName = invokeMatch[2];
    const bodyStart = invokeMatch.index + invokeMatch[0].length;
    const bodyEnd = findClosingTag(block, prefix, "invoke", bodyStart);
    if (bodyEnd === -1) continue;

    const paramsBody = block.slice(bodyStart, bodyEnd);
    const args = parseParams(paramsBody, prefix);
    out.push({ toolName, arguments: args });
  }
}

function parseParams(paramsBody: string, prefix: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};

  PARAM_RE.lastIndex = 0;
  let paramMatch: RegExpExecArray | null;

  while ((paramMatch = PARAM_RE.exec(paramsBody)) !== null) {
    const pfx = paramMatch[1];
    if (pfx !== prefix) continue;

    const key = paramMatch[2];
    const isString = paramMatch[3] === "true";
    const rawValue = paramMatch[4];

    if (isString) {
      args[key] = rawValue;
    } else {
      try {
        args[key] = JSON.parse(rawValue);
      } catch {
        args[key] = rawValue;
      }
    }
  }

  return args;
}

/** Quick check: does text contain DSML tool-call markup? */
export function hasDsml(text: string): boolean {
  TOOL_CALLS_OPEN_RE.lastIndex = 0;
  if (TOOL_CALLS_OPEN_RE.test(text)) return true;
  return /<\/[^\s>]{1,20}invoke\s*>/.test(text) ||
    /<[^\s>]{1,20}invoke\s+name\s*=\s*"/.test(text);
}

// ── Stream-level tool-call injection ───────────────────────────────────────

function emitToolCallEvents(
  controller: ReadableStreamDefaultController<Part>,
  toolCallId: string,
  toolName: string,
  inputJson: string,
) {
  controller.enqueue({
    type: "tool-input-start",
    id: toolCallId,
    toolName,
    dynamic: false,
    providerExecuted: false,
  });
  controller.enqueue({
    type: "tool-input-delta",
    id: toolCallId,
    delta: inputJson,
  });
  controller.enqueue({
    type: "tool-input-end",
    id: toolCallId,
  });
}

function tryInjectDsml(
  controller: ReadableStreamDefaultController<Part>,
  reasonBuf: string[],
  textBuf: string[],
  provider: string,
): boolean {
  const fullText = [...reasonBuf, ...textBuf].join("");

  // Decode HTML-escaped DSML (e.g. &lt;__invoke...&gt;)
  const decoded = fullText
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

  if (!hasDsml(decoded)) return false;

  const toolCalls = parseDsmlToolCalls(decoded);
  if (toolCalls.length === 0) return false;

  console.debug(
    "[kai] dsmlMiddleware: injecting %d synthetic tool call(s) for provider=%s",
    toolCalls.length,
    provider,
  );

  for (const tc of toolCalls) {
    emitToolCallEvents(
      controller,
      generateId(),
      tc.toolName,
      JSON.stringify(tc.arguments),
    );
  }

  return true;
}

// ── Middleware ─────────────────────────────────────────────────────────────

export function createDsmlMiddleware(): LanguageModelMiddleware {
  return {
    specificationVersion: "v3",

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapStream: (async ({ doStream, model }: any) => {
      const provider: string = (model as { provider?: string }).provider ?? "";

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const result: { stream: ReadableStream<Part>; [k: string]: unknown } =
        await doStream();
      const original = result.stream;

      let sawToolCall = false;
      const reasonBuf: string[] = [];
      const textBuf: string[] = [];
      let finishPart: Part | null = null;

      const transformed = new ReadableStream<Part>({
        async start(controller) {
          const reader = original.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                if (!sawToolCall) {
                  tryInjectDsml(controller, reasonBuf, textBuf, provider);
                }
                if (finishPart) controller.enqueue(finishPart);
                controller.close();
                return;
              }

              if (value?.type === "tool-call" || value?.type === "tool-input-start") {
                sawToolCall = true;
                controller.enqueue(value);
                continue;
              }

              if (value?.type === "reasoning-delta") {
                reasonBuf.push(String(value.delta ?? ""));
                controller.enqueue(value);
                continue;
              }
              if (value?.type === "text-delta") {
                textBuf.push(String(value.delta ?? ""));
                controller.enqueue(value);
                continue;
              }
              if (
                (value?.type === "text" || value?.type === "reasoning") &&
                typeof (value as { text?: unknown }).text === "string"
              ) {
                textBuf.push(String((value as { text: string }).text));
                controller.enqueue(value);
                continue;
              }

              if (value?.type === "finish" || value?.type === "error") {
                finishPart = value;
                if (!sawToolCall) {
                  tryInjectDsml(controller, reasonBuf, textBuf, provider);
                }
                controller.enqueue(value);
                controller.close();
                return;
              }

              controller.enqueue(value);
            }
          } catch (err) {
            controller.error(err);
          }
        },
      });

      return { ...result, stream: transformed };
    }) as LanguageModelMiddleware["wrapStream"],
  };
}