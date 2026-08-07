/**
 * Project Rules Engine — discovers and loads KAI.md, KAI.local.md, and
 * .kai/rules/*.md files from the workspace and ancestor directories.
 *
 * Modeled after Claude Code's CLAUDE.md discovery:
 *  - Walks up from workspace root to filesystem root, concatenating found files
 *  - Subdirectory KAI.md files are loaded on-demand when reading files in those dirs
 *  - .kai/rules/*.md supports YAML frontmatter `paths:` for file-scoped rules
 *  - KAI.local.md is gitignored, personal, loaded alongside KAI.md
 */

import { native } from "./native";

const KAI_MD_MAX_BYTES = 32 * 1024;
const RULES_DIR = ".kai/rules";
const KAI_MD = "KAI.md";
const KAI_LOCAL_MD = "KAI.local.md";

export type RuleEntry = {
  /** Path to the rules file (relative to workspace root, forward-slash). */
  source: string;
  /** Raw content of the rules file. */
  content: string;
};

export type PathScopedRule = {
  /** Glob patterns matching files this rule applies to. */
  paths: string[];
  /** Source file path for diagnostics. */
  source: string;
  /** The rule content (excluding frontmatter). */
  content: string;
};

export type ProjectRules = {
  /** Concatenated content of all KAI.md files from ancestor tree walk. */
  baseMemory: string;
  /** Personal, gitignored rules (KAI.local.md files). */
  localMemory: string;
  /** Global rules from .kai/rules/*.md (no paths frontmatter). */
  globalRules: RuleEntry[];
  /** Path-scoped rules from .kai/rules/*.md (with paths frontmatter). */
  scopedRules: PathScopedRule[];
  /** Original sources for diagnostics. */
  sources: string[];
};

function resolvePath(...parts: string[]): string {
  return parts
    .join("/")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/");
}

/**
 * Walk up the directory tree from `startPath` to the filesystem root,
 * collecting discovered files. Returns an array of { path, content }
 * in order from root → startPath (so deeper files override conceptually).
 */
async function walkUpTree(
  startPath: string,
  filename: string,
): Promise<RuleEntry[]> {
  const results: RuleEntry[] = [];
  const seen = new Set<string>();
  let current = startPath.replace(/\\/g, "/").replace(/\/$/, "");

  while (true) {
    if (current === "" || current === "/" || /^[A-Za-z]:\/*$/.test(current)) {
      break;
    }
    const filePath = resolvePath(current, filename);
    if (seen.has(filePath)) break;
    seen.add(filePath);

    try {
      const r = await native.readFile(filePath);
      if (r.kind === "text") {
        const capped =
          r.content.length > KAI_MD_MAX_BYTES
            ? r.content.slice(0, KAI_MD_MAX_BYTES)
            : r.content;
        results.push({ source: filePath, content: capped });
      }
    } catch {
      // File doesn't exist at this level — normal.
    }

    // Walk up one level.
    const parent = current.substring(0, current.lastIndexOf("/"));
    if (parent === current || parent === "") {
      // Check for Windows drive root edge case
      if (/^[A-Za-z]:$/.test(current)) {
        break;
      }
      break;
    }
    current = parent;
  }

  // Reverse so root-level files come first, workspace-level last.
  results.reverse();
  return results;
}

/**
 * Parse YAML frontmatter from a markdown string.
 * Supports `---` delimited frontmatter with a `paths:` key.
 * Returns [body, paths[]] or [fullContent, []].
 */
function parseFrontmatter(content: string): { body: string; paths: string[] } {
  if (!content.startsWith("---")) {
    return { body: content, paths: [] };
  }
  const endIdx = content.indexOf("---", 3);
  if (endIdx === -1) {
    return { body: content, paths: [] };
  }
  const fmBlock = content.slice(3, endIdx);
  const body = content.slice(endIdx + 3).trimStart();

  const paths: string[] = [];
  // Simple YAML path list parser — handles:
  //   paths:
  //     - "src/**/*.ts"
  //     - "lib/**"
  const pathMatch = fmBlock.match(/^paths\s*:\s*\n([\s\S]*?)(?:^\w|\Z)/m);
  if (pathMatch) {
    const listBlock = pathMatch[1];
    const lines = listBlock.split("\n");
    for (const line of lines) {
      const m = line.match(/^\s*-\s*["']?(.+?)["']?\s*$/);
      if (m) {
        paths.push(m[1].trim());
      }
    }
  }
  return { body, paths };
}

/**
 * Load .kai/rules/*.md files from the workspace root.
 * Returns global (no paths) and scoped (with paths) rules.
 */
async function loadRulesDirectory(
  workspaceRoot: string,
): Promise<{ global: RuleEntry[]; scoped: PathScopedRule[] }> {
  const dirPath = resolvePath(workspaceRoot, RULES_DIR);
  const global: RuleEntry[] = [];
  const scoped: PathScopedRule[] = [];

  let entries: { name: string; kind: string }[];
  try {
    entries = (await native.readDir(dirPath)).map((e) => ({
      name: e.name,
      kind: e.kind,
    }));
  } catch {
    return { global, scoped };
  }

  for (const entry of entries) {
    if (entry.kind !== "file" || !entry.name.endsWith(".md")) continue;
    const filePath = resolvePath(dirPath, entry.name);
    try {
      const r = await native.readFile(filePath);
      if (r.kind !== "text") continue;
      const capped =
        r.content.length > KAI_MD_MAX_BYTES
          ? r.content.slice(0, KAI_MD_MAX_BYTES)
          : r.content;
      const { body, paths } = parseFrontmatter(capped);
      if (paths.length > 0) {
        scoped.push({ paths, source: entry.name, content: body });
      } else {
        global.push({ source: entry.name, content: body });
      }
    } catch {
      // Skip unreadable files.
    }
  }

  return { global, scoped };
}

// ── Cache ─────────────────────────────────────────────────────────────

type CacheEntry = {
  rules: ProjectRules;
  mtime: number;
};

const rulesCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000;

/**
 * Load all project rules for a workspace root. Results are cached for 30s.
 */
export async function loadProjectRules(
  workspaceRoot: string | null,
): Promise<ProjectRules> {
  const empty: ProjectRules = {
    baseMemory: "",
    localMemory: "",
    globalRules: [],
    scopedRules: [],
    sources: [],
  };
  if (!workspaceRoot) return empty;

  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/$/, "");
  const cached = rulesCache.get(root);
  if (cached && Date.now() - cached.mtime < CACHE_TTL_MS) {
    return cached.rules;
  }

  try {
    // 1. Walk up for KAI.md files
    const baseEntries = await walkUpTree(root, KAI_MD);
    const baseMemory = baseEntries.map((e) => e.content).join("\n\n");

    // 2. Walk up for KAI.local.md files
    const localEntries = await walkUpTree(root, KAI_LOCAL_MD);
    const localMemory = localEntries.map((e) => e.content).join("\n\n");

    // 3. Load .kai/rules/ directory
    const { global: globalRules, scoped: scopedRules } =
      await loadRulesDirectory(root);

    // 4. Collect sources for diagnostics
    const sources = [
      ...baseEntries.map((e) => e.source),
      ...localEntries.map((e) => e.source),
      ...globalRules.map((r) => resolvePath(root, RULES_DIR, r.source)),
      ...scopedRules.map((r) => resolvePath(root, RULES_DIR, r.source)),
    ];

    const rules: ProjectRules = {
      baseMemory: baseMemory.trim(),
      localMemory: localMemory.trim(),
      globalRules,
      scopedRules,
      sources,
    };

    rulesCache.set(root, { rules, mtime: Date.now() });
    return rules;
  } catch {
    rulesCache.set(root, { rules: empty, mtime: Date.now() });
    return empty;
  }
}

/**
 * Get path-scoped rules that apply to a given file path.
 */
export function getScopedRulesForFile(
  rules: ProjectRules,
  filePath: string,
): string {
  if (rules.scopedRules.length === 0) return "";
  const normalized = filePath.replace(/\\/g, "/");
  const applicable = rules.scopedRules.filter((rule) =>
    rule.paths.some((pattern) => matchGlob(normalized, pattern)),
  );
  if (applicable.length === 0) return "";
  return applicable.map((r) => r.content).join("\n\n");
}

/**
 * Simple glob matcher for path scoping. Supports:
 *  - `**` (any depth)
 *  - `*` (single segment, no slash)
 *  - literal match
 */
function matchGlob(filePath: string, pattern: string): boolean {
  const parts = pattern.split("/");
  const fileParts = filePath.split("/");

  let fi = 0;
  let pi = 0;

  while (pi < parts.length && fi < fileParts.length) {
    const p = parts[pi];
    if (p === "**") {
      // Greedy match: consume zero or more segments.
      if (pi === parts.length - 1) return true; // ** at end matches everything
      pi++;
      const next = parts[pi];
      // Find next matching segment
      while (fi < fileParts.length && !matchSegment(fileParts[fi], next)) {
        fi++;
      }
      if (fi >= fileParts.length) return false;
    } else {
      if (!matchSegment(fileParts[fi], p)) return false;
      pi++;
      fi++;
    }
  }

  // If we consumed all pattern parts and all file parts, it's a match.
  // If pattern ends with **, remaining file parts are OK.
  if (pi === parts.length && fi === fileParts.length) return true;
  if (pi === parts.length - 1 && parts[pi] === "**") return true;
  return false;
}

function matchSegment(filePart: string, pattern: string): boolean {
  if (pattern === "*") return true;
  // Support simple globs: *.ts, test*.ts
  if (pattern.includes("*")) {
    const re = new RegExp(
      "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
    );
    return re.test(filePart);
  }
  return filePart === pattern;
}

/**
 * Format project rules for inclusion in the system prompt.
 */
export function formatRulesForPrompt(rules: ProjectRules): string {
  const blocks: string[] = [];

  // Main KAI.md content (ancestor tree walk).
  if (rules.baseMemory.length > 0) {
    blocks.push(`## PROJECT — Kai.md\n${rules.baseMemory}`);
  }

  // Local rules.
  if (rules.localMemory.length > 0) {
    blocks.push(`## PROJECT — KAI.local.md\n${rules.localMemory}`);
  }

  // Global rules directory.
  for (const rule of rules.globalRules) {
    if (rule.content.trim().length > 0) {
      blocks.push(`## RULE — ${rule.source}\n${rule.content.trim()}`);
    }
  }

  return blocks.join("\n\n");
}

/**
 * Invalidate the cache (call on workspace change).
 */
export function invalidateRulesCache(): void {
  rulesCache.clear();
}