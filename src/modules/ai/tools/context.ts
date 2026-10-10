import type { FileTracker } from "../lib/fileTracker";

export type ToolContext = {
  /** Active terminal tab cwd, used to resolve relative paths. Null = home. */
  getCwd: () => string | null;
  /** Workspace root (explorer root). Used by tools that operate over the project. */
  getWorkspaceRoot: () => string | null;
  /**
   * The REAL project root, NOT shadow-redirected. File/shell tools use
   * `getWorkspaceRoot` (which points into the detached copy while one is
   * active); state that must survive merge/discard — memory, checkpoints,
   * sessions — must key off this real root instead.
   */
  getRealWorkspaceRoot?: () => string | null;
  /** Last N lines of the active terminal buffer (or null if not a terminal tab). */
  getTerminalContext: () => string | null;
  isActiveTerminalPrivate: () => boolean;
  /**
   * Type a string into the active terminal at the prompt — without executing.
   * Returns false if there is no active terminal tab to inject into.
   */
  injectIntoActivePty: (text: string) => boolean;
  /** Open a new preview tab (in-app iframe) at the given URL. */
  openPreview: (url: string) => boolean;
  readCache: Map<string, { size: number; hash: number }>;
  /** Active chat session id — used by tools that persist per-session state (todos). */
  getSessionId: () => string | null;
  /** Tracks files read/modified during this session for smarter compaction. */
  fileTracker: FileTracker;
  /**
   * Approximate remaining token budget for this chat session.
   * Tools can use this to auto-truncate responses when context is tight.
   * Returns 0 if unknown (never used as a negative). */
  getRemainingContextTokens?: () => number;
  /**
   * Whether the CURRENT model's provider can receive IMAGES in tool-result
   * content (image-data parts). The openai-compatible family (DeepSeek,
   * Mistral, OpenRouter, z.ai, Groq, xAI, Cerebras, LM Studio, custom)
   * stringify tool-result content parts — an image part becomes megabytes
   * of base64 text the model cannot read. When false, image-returning tools
   * fall back to OCR text. Absent = true (first-party providers).
   */
  supportsToolResultImages?: () => boolean;
};

/**
 * Providers whose tool-result content parts can carry images. Verified
 * against the installed SDK dists: anthropic renders image-data as a base64
 * image block inside tool_result, openai as input_image, google as
 * inlineData. Everything else in the PROVIDERS list rides
 * openai-compatible-style stringification.
 */
export const TOOL_RESULT_IMAGE_PROVIDERS: ReadonlySet<string> = new Set([
  "openai",
  "anthropic",
  "google",
]);

export function resolvePath(rawPath: string, cwd: string | null): string {
  if (rawPath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(rawPath))
    return rawPath;
  if (!cwd)
    throw new Error(
      `cannot resolve relative path "${rawPath}": no active terminal cwd. Pass an absolute path.`,
    );
  const sep = cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/";
  return cwd.endsWith(sep) ? `${cwd}${rawPath}` : `${cwd}${sep}${rawPath}`;
}
