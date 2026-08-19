/**
 * DSML (DeepSeek Markup Language) stream middleware.
 *
 * DeepSeek V4 models emit tool calls using a DSML XML format with the
 * `__` namespace token (two underscores), e.g.:
 *
 *   <__tool_calls>
 *     <__invoke name="edit">
 *       <__parameter name="path" string="true">src/file.ts</__parameter>
 *       <__parameter name="old_string" string="true">...</__parameter>
 *       <__parameter name="new_string" string="true">...</__parameter>
 *     </__invoke>
 *   </__tool_calls>
 *
 * When routed through providers that don't convert DSML into structured
 * OpenAI-format tool_calls (notably OpenRouter), the stream ends with
 * finishReason: stop and zero tool calls — the agent silently stops
 * mid-thinking.
 *
 * This middleware intercepts the low-level V3 stream, buffers
 * reasoning+text deltas, and on finish injects synthetic
 * tool-input-* events parsed from any DSML fragments found.
 */

import { generateId, type LanguageModelMiddleware } from "ai";

// ── DSML regex patterns ────────────────────────────────────────────────────
// The DSML namespace is the literal two-underscore string "__".
// Some renderings may use HTML entities (&amp;#95;&amp;#95;) from
// different prompt-template encodings.

/** Match any DSML namespace prefix variation. */
const INVOKE_MARKER = new RegExp(
    "<(?:__|&#95;&#95;|&#x5F;&#x5F;)invoke\\s+name=\"([^\"]+)\">",
  );

/** Match a tool-calls block (accepts any namespace form). */
const TOOL_CALLS_RE = new RegExp(
  "<(?:__|&#95;&#95;|&#x5F;&#x5F;)tool_calls>([\\s\\S]*?)</(?:__|&#95;&#95;|&#x5F;&#x5F;)tool_calls>",
  "g",
);

/** Match an invoke tag inside a block. */
const INVOKE_RE = new RegExp(
  "<(?:__|&#95;&#95;|&#x5F;&#x5F;)invoke\\s+name=\"([^\"]+)\">\\s*([\\s\\S]*?)\\s*</(?:__|&#95;&#95;|&#x5F;&#x5F;)invoke>",
  "gs",
);

/** Match a parameter tag. */
const PARAM_RE = new RegExp(
  "<(?:__|&#95;&#95;|&#x5F;&#x5F;)parameter\\s+name=\"([^\"]+)\"\\s+string=\"(true|false)\">([\\s\\S]*?)</(?:__|&#95;&#95;|&#x5F;&#x5F;)parameter>",
  "gs",
);

// ── Types ──────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Part = any;

type DsmlToolCall = {
  toolName: string;
  arguments: Record<string, unknown>;
};

// ── DSML parser ────────────────────────────────────────────────────────────

/** Extract tool calls from raw model text containing DSML fragments. */
export function parseDsmlToolCalls(text: string): DsmlToolCall[] {
  const calls: DsmlToolCall[] = [];

  // Strategy: first try to find wrapped blocks, then fall back to bare
  // <__invoke> tags (some models skip the <__tool_calls> wrapper).

  // Reset all regex lastIndex.
  TOOL_CALLS_RE.lastIndex = 0;
  INVOKE_RE.lastIndex = 0;
  PARAM_RE.lastIndex = 0;

  let blockMatch: RegExpExecArray | null;
  let foundBlock = false;
  while ((blockMatch = TOOL_CALLS_RE.exec(text)) !== null) {
    foundBlock = true;
    const block = blockMatch[1];
    parseBlock(block, calls);
  }

  // If no wrapped blocks found, search the entire text for bare invoke tags.
  if (!foundBlock) {
    INVOKE_RE.lastIndex = 0;
    let invokeMatch: RegExpExecArray | null;
    while ((invokeMatch = INVOKE_RE.exec(text)) !== null) {
      const toolName = invokeMatch[1];
      const paramsBody = invokeMatch[2];
      const args = parseParams(paramsBody);
      calls.push({ toolName, arguments: args });
    }
  }

  return calls;
}

function parseBlock(block: string, out: DsmlToolCall[]): void {
  INVOKE_RE.lastIndex = 0;

  let invokeMatch: RegExpExecArray | null;
  while ((invokeMatch = INVOKE_RE.exec(block)) !== null) {
    const toolName = invokeMatch[1];
    const paramsBody = invokeMatch[2];
    const args = parseParams(paramsBody);
    out.push({ toolName, arguments: args });
  }
}

function parseParams(paramsBody: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};

  PARAM_RE.lastIndex = 0;
  let paramMatch: RegExpExecArray | null;
  while ((paramMatch = PARAM_RE.exec(paramsBody)) !== null) {
    const key = paramMatch[1];
    const isString = paramMatch[2] === "true";
    const rawValue = paramMatch[3];

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
  return INVOKE_MARKER.test(text) ||
    text.includes("&lt;__invoke name=&quot;") ||
    /__invoke\s+name=/.test(text);
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
              if (done) break;

              if (value?.type === "tool-input-start") {
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
              // Some providers emit complete text/reasoning parts (non-delta).
              if ((value?.type === "text" || value?.type === "reasoning") && typeof (value as { text?: unknown }).text === "string") {
                textBuf.push(String((value as { text: string }).text));
                controller.enqueue(value);
                continue;
              }
              if (value?.type === "finish" || value?.type === "error") {
                finishPart = value;
                continue;
              }
              controller.enqueue(value);
            }

            if (!sawToolCall && finishPart) {
              const fullText = [...reasonBuf, ...textBuf].join("");
              // Decode HTML-escaped DSML (e.g. &lt;__invoke...&gt;)
              const decoded = fullText
                .replace(/&lt;/g, "<")
                .replace(/&gt;/g, ">")
                .replace(/&quot;/g, '"')
                .replace(/&amp;/g, "&");
              if (hasDsml(decoded)) {
                const toolCalls = parseDsmlToolCalls(decoded);
                console.debug(
                  "[kai] dsmlMiddleware: injected synthetic tool calls for provider=%s (%d tools)",
                  provider,
                  toolCalls.length,
                );
                for (const tc of toolCalls) {
                  emitToolCallEvents(
                    controller,
                    generateId(),
                    tc.toolName,
                    JSON.stringify(tc.arguments),
                  );
                }
              }
            }

            if (finishPart) controller.enqueue(finishPart);
            controller.close();
          } catch (err) {
            controller.error(err);
          }
        },
      });

      return { ...result, stream: transformed };
    }) as LanguageModelMiddleware["wrapStream"],
  };
}