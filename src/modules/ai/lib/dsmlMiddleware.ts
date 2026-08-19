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

const NS = "__";

/** Match a full <__tool_calls>...</__tool_calls> block. */
const TOOL_CALLS_RE = new RegExp(
  `<${NS}tool_calls>([\\s\\S]*?)</${NS}tool_calls>`,
  "g",
);

/** Match <__invoke name="tool_name">...</__invoke> (dotAll). */
const INVOKE_RE = new RegExp(
  `<${NS}invoke name="([^"]+)">([\\s\\S]*?)</${NS}invoke>`,
  "gs",
);

/** Match <__parameter name="key" string="true|false">value</__parameter> (dotAll). */
const PARAM_RE = new RegExp(
  `<${NS}parameter name="([^"]+)" string="(true|false)">([\\s\\S]*?)</${NS}parameter>`,
  "gs",
);

// ── Types ──────────────────────────────────────────────────────────────────

/** Opaque stream part — we only care about a few string fields at runtime. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Part = any;

type DsmlToolCall = {
  toolName: string;
  arguments: Record<string, unknown>;
};

export type DsmlMiddlewareOptions = {
  /**
   * Only apply to specific provider ids (e.g. "openrouter").
   * If omitted, applies to every provider.
   */
  providerFilter?: string | string[];
};

// ── DSML parser ────────────────────────────────────────────────────────────

/** Extract tool calls from raw model text containing DSML fragments. */
export function parseDsmlToolCalls(text: string): DsmlToolCall[] {
  const calls: DsmlToolCall[] = [];

  TOOL_CALLS_RE.lastIndex = 0;

  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = TOOL_CALLS_RE.exec(text)) !== null) {
    const block = blockMatch[1];

    INVOKE_RE.lastIndex = 0;
    let invokeMatch: RegExpExecArray | null;
    while ((invokeMatch = INVOKE_RE.exec(block)) !== null) {
      const toolName = invokeMatch[1];
      const paramsBody = invokeMatch[2];

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
          // JSON-encoded value — attempt to parse
          try {
            args[key] = JSON.parse(rawValue);
          } catch {
            args[key] = rawValue;
          }
        }
      }

      calls.push({ toolName, arguments: args });
    }
  }

  return calls;
}

/** Quick check: does text contain DSML tool-call markup? */
export function hasDsml(text: string): boolean {
  return text.includes(`${NS}invoke name="`);
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

export function createDsmlMiddleware(
  options: DsmlMiddlewareOptions = {},
): LanguageModelMiddleware {
  const filter = options.providerFilter
    ? Array.isArray(options.providerFilter)
      ? new Set(options.providerFilter)
      : new Set([options.providerFilter])
    : null;

  return {
    specificationVersion: "v3",

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapStream: (async ({ doStream, model }: any) => {
      const provider: string = model.provider;
      if (filter && !filter.has(provider)) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return doStream();
      }

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
              if (value?.type === "finish") {
                finishPart = value;
                continue;
              }
              controller.enqueue(value);
            }

            if (!sawToolCall && finishPart) {
              const fullText = [...reasonBuf, ...textBuf].join("");
              if (hasDsml(fullText)) {
                const toolCalls = parseDsmlToolCalls(fullText);
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