import type { ModelMessage } from "ai";

export type MediaResultShape = {
  type: "image" | "video";
  provider?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  savedPath?: string;
  url?: string;
  error?: string;
  prompt?: string;
  count?: number;
  [k: string]: unknown;
};

/** Recognize a resolved generate_image/generate_video tool output. */
export function isMediaResultShape(v: unknown): v is MediaResultShape {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    (o.type === "image" || o.type === "video") &&
    ("base64" in o || typeof o.url === "string")
  );
}

/** The model needs the saved path and outcome, never the display payload. */
export function mediaSummary(o: MediaResultShape): Record<string, unknown> {
  const bits = [o.type === "video" ? "video" : "image"];
  if (o.width && o.height) bits.push(`${o.width}x${o.height}`);
  if (typeof o.durationSeconds === "number" && o.durationSeconds > 0) {
    bits.push(`${o.durationSeconds}s`);
  }
  if (o.provider) bits.push(`provider: ${o.provider}`);
  return {
    type: o.type,
    summary: `generated ${bits.join(", ")}`,
    ...(o.savedPath ? { savedPath: o.savedPath } : {}),
    note: o.savedPath
      ? o.type === "image"
        ? "The image is saved at savedPath. Pass that path to generate_image (imagePath) to EDIT it or generate_video (imagePath) to ANIMATE it."
        : "The video is saved at savedPath."
      : "The media is displayed in the chat card only (not saved to disk).",
  };
}

/** Safe for both UIMessage.raw outputs and AI SDK tool_toModelOutput envelopes. */
export function summarizeMediaToolResult(output: unknown): unknown {
  if (isMediaResultShape(output)) return mediaSummary(output);
  if (!output || typeof output !== "object" || Array.isArray(output)) return output;
  const record = output as { type?: unknown; value?: unknown };
  // convertToModelMessages preserves already-serialized text envelopes too.
  if (record.type === "text" && typeof record.value === "string") {
    const trimmed = record.value.trimStart();
    if (trimmed.startsWith('{"type":"image"') || trimmed.startsWith('{"type":"video"')) {
      try {
        const parsed = JSON.parse(record.value) as unknown;
        if (isMediaResultShape(parsed)) return { ...output, value: JSON.stringify(mediaSummary(parsed)) };
      } catch {
        return output;
      }
    }
  }
  // convertToModelMessages wraps structured outputs as {type:"json", value}.
  if ((record.type === "json" || record.type === "text") && isMediaResultShape(record.value)) {
    return { ...output, value: mediaSummary(record.value) };
  }
  return output;
}

/** Summarize media AFTER convertToModelMessages too. Without this, the SDK's
 *  {type:"json", value:{...base64...}} envelope hides every payload from a
 *  shape-only matcher and megabytes re-ride each provider request. */
export function summarizeMediaOutputs(messages: ModelMessage[]): ModelMessage[] {
  let touched = false;
  const out = messages.map((message): ModelMessage => {
    if (!Array.isArray(message.content)) return message;
    let messageTouched = false;
    const content = (message.content as Record<string, unknown>[]).map((part) => {
      if (part.type !== "tool-result") return part;
      const summarized = summarizeMediaToolResult(part.output);
      if (summarized === part.output) return part;
      messageTouched = true;
      return { ...part, output: summarized };
    });
    if (!messageTouched) return message;
    touched = true;
    return { ...message, content } as ModelMessage;
  });
  return touched ? out : messages;
}
