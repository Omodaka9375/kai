import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * KAI.md drift gate — the dsh "every rule is verifiable" principle applied
 * to the two claim types in the project doc that rot silently:
 *
 *  1. PATH CLAIMS. KAI.md names concrete source files (`pty/session.rs`,
 *     `lib/security.ts`, `tools/tools.ts`…). When a file moves or is renamed,
 *     the doc keeps pointing at a path that no longer exists and the next
 *     agent wastes a hunt. Gate: every path-shaped backtick token resolves to
 *     a real file (exact repo-relative, or by basename under src/ ·
 *     src-tauri/src).
 *
 *  2. TOOL INVENTORY. KAI.md carries a `### Tools (inventory)` section
 *     listing model-facing tool names split by whether they need approval.
 *     This is the surface the project has repeatedly drifted on (the phantom
 *     `fs_grep`, the prompt-vs-registry mismatch). Gate: those lists match
 *     what src/modules/ai/tools/*.ts ACTUALLY registers, parsed straight from
 *     `name: tool({ … needsApproval: true })`.
 *
 * Command-name claims are DELIBERATELY out of scope: KAI.md's backticks are
 * full of arbitrary code (`.unwrap()`, `Channel<PtyEvent>`, shell snippets)
 * and no token classifier separates "this backtick asserts a Tauri command"
 * from "this is an inline example" without the noise swallowing the signal.
 * dsh gates only what is mechanically checkable; so do we.
 */

const here = dirname(fileURLToPath(import.meta.url));
// src/modules/ai/lib → repo root is four up.
const repoRoot = resolve(here, "..", "..", "..", "..");

/** Walk a directory tree collecting relative paths (bounded, skips VCS). */
function walk(dir: string, acc: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === ".git" || name === "node_modules" || name === "target" || name === "dist") continue;
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(abs, acc);
    else acc.push(abs.slice(repoRoot.length + 1).split(sep).join("/"));
  }
}

const allFiles: string[] = [];
// Walk the whole repo (walk() skips .git/node_modules/target/dist) so
// src-tauri/capabilities/default.json, Info.plist, root config files, etc.
// all resolve as path claims.
walk(repoRoot, allFiles);
const basenames = new Set(allFiles.map((p) => p.split("/").pop()!));

/** Top-level directories that make a slash-path a repo-path claim. */
const KNOWN_TOP_DIRS = new Set(["src", "src-tauri", "public", "docs", "scripts"]);

const kaiMd = readFileSync(join(repoRoot, "KAI.md"), "utf8");

/** Backtick tokens in the doc. */
const backtickTokens = [...kaiMd.matchAll(/`([^`\r\n]+)`/g)].map((m) => m[1]!);

/** Runtime store file names KAI.md mentions that are NOT repo files (they
 *  live in the app-data dir at runtime). Not drift — exempt them. */
const RUNTIME_STORE_ALLOW = new Set([
  "kai-sessions.json",
  "kai-mcp.json",
  "audit.jsonl",
]);

const CODE_EXT = /\.(ts|tsx|js|jsx|rs|json|md|css|scss|html|bash|zsh|ps1|plist|toml|ya?ml|lock)$/;

/** Does this token read as a concrete repo path/file claim? */
function isPathClaim(tok: string): boolean {
  // Anything with shell/code punctuation, whitespace, a URL, or a glob is an
  // inline example, not a path assertion.
  if (/[<>*?|()[\]{}"`\\,\s]|:\/\//.test(tok)) return false;
  if (CODE_EXT.test(tok)) return true; // tauri.conf.json, session.rs, App.css
  // A slash-path is a claim only when it starts at a real top-level dir —
  // this skips git-status markers (w/crlf, w/mixed) and stray fragments.
  if (tok.includes("/")) {
    const first = tok.replace(/\/+$/, "").split("/")[0]!;
    return KNOWN_TOP_DIRS.has(first);
  }
  return false;
}

function pathClaimResolves(tok: string): boolean {
  if (RUNTIME_STORE_ALLOW.has(tok)) return true;
  const trailingDir = tok.endsWith("/");
  const clean = tok.replace(/\/+$/, "");
  if (existsSync(join(repoRoot, clean))) return true;
  if (basenames.has(clean)) return true;
  // SUFFIX match: KAI.md uses module-relative shorthand — `pty/session.rs`
  // means src-tauri/src/modules/pty/session.rs, `lib/agent.ts` means
  // src/modules/ai/lib/agent.ts. Existence (not uniqueness) is the claim.
  const needle = "/" + clean;
  if (allFiles.some((f) => f.endsWith(needle))) return true;
  // Dir-style token: any tracked file under it.
  if (trailingDir || !CODE_EXT.test(clean)) {
    return allFiles.some((f) => f.startsWith(clean + "/") || f.includes("/" + clean + "/"));
  }
  return false;
}

describe("KAI.md path claims resolve to real files", () => {
  it("every path-shaped backtick token points at something that exists", () => {
    const claims = [...new Set(backtickTokens.filter(isPathClaim))];
    expect(claims.length).toBeGreaterThan(10); // sanity: the doc DOES make path claims
    const broken = claims.filter((t) => !pathClaimResolves(t));
    // Human-readable failure listing the stale pointers + the file that
    // mentioned them, so the fix is obvious.
    expect(
      broken,
      `KAI.md references paths that do not exist:\n  ${broken.join("\n  ")}`,
    ).toEqual([]);
  });
});

describe("KAI.md tool inventory matches the live registry", () => {
  /** Parse the real tool set straight from the sources. */
  function liveToolApproval(): Map<string, boolean> {
    const toolsDir = join(repoRoot, "src", "modules", "ai", "tools");
    const result = new Map<string, boolean>();
    for (const file of readdirSync(toolsDir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const txt = readFileSync(join(toolsDir, file), "utf8");
      const idxs = [...txt.matchAll(/^ {2,4}([a-z_0-9]+):\s*tool\(/gm)];
      for (let i = 0; i < idxs.length; i++) {
        const start = idxs[i]!.index!;
        const end = i + 1 < idxs.length ? idxs[i + 1]!.index! : txt.length;
        const block = txt.slice(start, end);
        const name = idxs[i]![1]!;
        const needsApproval = /\bneedsApproval:\s*true\b/.test(block);
        result.set(name, needsApproval);
      }
    }
    return result;
  }

  /** Pull the two lists out of the `### Tools (inventory)` section. */
  function docLists(): { auto: string[]; approval: string[]; present: boolean } {
    const section = kaiMd.split(/^### Tools \(inventory\)/m)[1];
    if (!section) return { auto: [], approval: [], present: false };
    // Stop at the next heading.
    const body = section.split(/^#{2,3} /m)[0]!;
    const grab = (label: string): string[] => {
      // Line-anchored: "- <label>: …" — prose mentions of the phrase must
      // not capture (the labels appear in sentences above the lists).
      const m = body.match(
        new RegExp("^[-*]?\\s*" + label + ":[^\\r\\n]*", "im"),
      );
      if (!m) return [];
      return m[0]!
        .replace(/^[-*]?\s*[^:]+:/, "")
        .split(",")
        .map((s) => s.trim().replace(/[`*.]/g, ""))
        .filter((s) => /^[a-z_0-9]+$/.test(s));
    };
    return {
      auto: grab("Auto-execute"),
      approval: grab("Approval-required"),
      present: true,
    };
  }

  it("the inventory section exists", () => {
    expect(docLists().present).toBe(true);
  });

  it("the doc's listed tools are a subset of the live registry (no phantom tools)", () => {
    const live = liveToolApproval();
    const { auto, approval } = docLists();
    const phantoms = [...auto, ...approval].filter((t) => !live.has(t));
    expect(
      phantoms,
      `KAI.md lists tools that no longer exist in src/modules/ai/tools: ${phantoms.join(", ")}`,
    ).toEqual([]);
  });

  it("the approval split is accurate", () => {
    const live = liveToolApproval();
    const { auto, approval } = docLists();
    const misclassified: string[] = [];
    for (const t of auto) if (live.get(t) === true) misclassified.push(`${t} (doc:auto, code:approval)`);
    for (const t of approval) if (live.get(t) === false) misclassified.push(`${t} (doc:approval, code:auto)`);
    expect(misclassified, `tool approval drift:\n  ${misclassified.join("\n  ")}`).toEqual([]);
  });

  it("every approval-required tool in code is listed in the doc (no silent additions)", () => {
    const live = liveToolApproval();
    const { approval } = docLists();
    const undocumented = [...live.entries()]
      .filter(([, needs]) => needs)
      .map(([n]) => n)
      .filter((n) => !approval.includes(n));
    expect(
      undocumented,
      `tools marked needsApproval:true but missing from KAI.md inventory: ${undocumented.join(", ")}`,
    ).toEqual([]);
  });

  it("every auto-execute tool in code is listed too (both directions)", () => {
    const live = liveToolApproval();
    const { auto } = docLists();
    const undocumented = [...live.entries()]
      .filter(([, needs]) => !needs)
      .map(([n]) => n)
      .filter((n) => !auto.includes(n));
    expect(
      undocumented,
      `auto-execute tools missing from KAI.md inventory: ${undocumented.join(", ")}`,
    ).toEqual([]);
  });
});
