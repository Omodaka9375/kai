import type { UIMessage } from "ai";
import { summarizeMediaToolResult } from "./modelSummary";

/** Rough model-input estimate. Preview bytes are not sent as tool-result text:
 *  count their model summary instead of letting media fill the indicator. */
export function estimateContextTokens(messages: UIMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "text" || part.type === "reasoning") {
        chars += (part as { text?: string }).text?.length ?? 0;
      } else if (part.type.startsWith("tool-")) {
        const toolPart = part as { input?: unknown; output?: unknown };
        if (toolPart.input) chars += JSON.stringify(toolPart.input).length;
        if (toolPart.output) {
          chars += JSON.stringify(summarizeMediaToolResult(toolPart.output)).length;
        }
      } else if (part.type === "file") {
        const file = part as { url?: string; data?: string };
        chars += (file.url ?? file.data ?? "").length;
      }
    }
  }
  return Math.ceil(chars / 4);
}
