/**
 * Smart File Context — auto-discovers relevant files for the current task.
 *
 * Uses lightweight keyword matching against recently read/modified file paths
 * and their content to suggest potentially relevant files to the agent.
 * This reduces the "search phase" at the start of each task.
 */

import type { FileTracker } from "./fileTracker";

export type RelevantFile = {
  path: string;
  reason: "recently_read" | "recently_modified" | "path_match" | "open_in_editor";
};

/**
 * Maximum number of relevant file hints to inject into context.
 */
const MAX_HINTS = 5;

/**
 * Score how relevant a file path is to a user message.
 * Simple keyword overlap — fast enough to run on every message.
 */
function scorePathRelevance(filePath: string, queryWords: Set<string>): number {
  const pathLower = filePath.toLowerCase();
  let score = 0;
  for (const word of queryWords) {
    if (pathLower.includes(word)) score += 2;
    // Bonus for exact filename match.
    const basename = pathLower.split("/").pop()?.split("\\").pop() ?? "";
    if (basename === word || basename.startsWith(word) || word.startsWith(basename)) {
      score += 5;
    }
  }
  return score;
}

/**
 * Extract meaningful words from a user message.
 */
function extractQueryWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9_./\\-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

/**
 * Get a list of files potentially relevant to the user's current message.
 *
 * Uses three signals:
 *  1. Recently read files (from fileTracker)
 *  2. Recently modified files
 *  3. Path keyword matching against open editor tabs
 */
export function getRelevantFiles(
  userMessage: string | null,
  fileTracker: FileTracker,
  openEditorPaths: string[],
): RelevantFile[] {
  if (!userMessage || !userMessage.trim()) return [];

  const words = extractQueryWords(userMessage);
  if (words.size === 0) return [];

  const seen = new Set<string>();
  const results: RelevantFile[] = [];

  // 1. Files tracked during this session — modified files first, then reads.
  const snapshot = fileTracker.getSnapshot();
  const modified = snapshot.filter((f) => f.state === "modified");
  const reads = snapshot.filter((f) => f.state === "read");

  for (const { path } of modified) {
    if (seen.has(path)) continue;
    const score = scorePathRelevance(path, words);
    if (score > 0) {
      seen.add(path);
      results.push({ path, reason: "recently_modified" });
    }
  }

  for (const { path } of reads) {
    if (seen.has(path)) continue;
    const score = scorePathRelevance(path, words);
    if (score > 0) {
      seen.add(path);
      results.push({ path, reason: "recently_read" });
    }
  }

  // 3. Open editor tabs — keyword match.
  for (const path of openEditorPaths) {
    if (seen.has(path)) continue;
    const score = scorePathRelevance(path, words);
    if (score > 1) {
      seen.add(path);
      results.push({ path, reason: "open_in_editor" });
    }
  }

  // Sort by relevance and cap.
  return results.slice(0, MAX_HINTS);
}

/**
 * Format relevant file hints for injection into the system prompt.
 */
export function formatRelevantFiles(files: RelevantFile[]): string {
  if (files.length === 0) return "";
  const lines = files.map(
    (f) => `- ${f.path} (${f.reason.replace(/_/g, " ")})`,
  );
  return `\n\n<relevant_files>\n${lines.join("\n")}\n</relevant_files>`;
}