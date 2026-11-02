/**
 * Skills — KAI's unified reusable-capability artifact (2026-11-02).
 *
 * A skill is a FOLDER with a SKILL.md file, Anthropic-Agent-Skills
 * compatible (community skills drop in by copying a folder):
 *
 *   ~/.kai/skills/<name>/SKILL.md       (global — every project, the
 *                                       "save permanently to KAI" scope)
 *   <project>/.kai/skills/<name>/SKILL.md  (project — this repo only)
 *
 * SKILL.md shape (frontmatter subset — parsed by parseSkillMd, no YAML dep):
 *
 *   ---
 *   name: deploy-status
 *   description: What it does and when to use it. One line.
 *   handle: deploy            (optional — the composer #handle; defaults to name)
 *   mcp-servers: [linear, github]  (optional — servers activated when used)
 *   agent: false              (optional — hidden from list_skills; #handle only)
 *   ---
 *   # Instructions body (markdown)
 *
 * TWO INVOCATION PATHS (deliberate — see the 2026-11-02 design discussion):
 *  - HUMAN: `#handle` in the composer expands the body into the message
 *    exactly like the legacy snippets did. Zero context cost until used;
 *    the human is the retriever. A skill needs no prior agent knowledge.
 *  - AGENT (pull model): `list_skills` returns name/description/handle/path
 *    ONLY — never bodies. The agent reads the SKILL.md path on demand.
 *    NOTHING is pushed into the system prompt, so the per-request cost is
 *    constant regardless of library size (50 skills ≈ 5 skills ≈ 0 tokens
 *    until something is actually used).
 *
 * Creation is HUMAN-GATED (create_skill/update_skill tools are
 * approval-required and their descriptions forbid proactive offers — the
 * "spammy false positives on complicated queries" failure mode).
 *
 * Migration: legacy kai-snippets.json entries became global skills
 * one-time (see store/skillsStore.ts); the old file is left on disk as a
 * backup. The `#handle` tokens and the expansion format carried over.
 */

import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import type { WorkspaceEnv } from "@/modules/workspace/env";

// ── Types ─────────────────────────────────────────────────────────────────

export type SkillScope = "global" | "project";

/** A parsed skill (frontmatter + body + where it lives). */
export type Skill = {
  /** Kebab dir name — also the stable id. */
  name: string;
  /** The composer `#handle`. Defaults to name. */
  handle: string;
  description: string;
  /** SKILL.md body (instructions). Loaded at scan time — the composer
   *  expansion needs it synchronously. */
  content: string;
  /** MCP server ids activated when this skill is used. */
  mcpServers: string[];
  /** frontmatter `agent: false` — hidden from list_skills; #handle only. */
  agentHidden: boolean;
  scope: SkillScope;
  /** Absolute skill folder (forward slashes). */
  dir: string;
  /** Absolute SKILL.md path (forward slashes). */
  skillMdPath: string;
};

/** Draft shape for creating/writing a skill (no fs coordinates). */
export type SkillDraft = {
  name: string;
  handle?: string;
  description: string;
  content: string;
  mcpServers?: string[];
  agentHidden?: boolean;
};

// ── Handle helpers (unchanged contract from the legacy snippet system) ─────

const HANDLE_RE = /^[a-z0-9][a-z0-9-]*$/;

export function normalizeHandle(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function isValidHandle(h: string): boolean {
  return HANDLE_RE.test(h);
}

/** kebab name validation — dir names share the handle alphabet. */
export function isValidSkillName(name: string): boolean {
  return HANDLE_RE.test(name);
}

// ── Frontmatter (subset parser — no YAML dependency) ───────────────────────

export type ParsedFrontmatter = {
  name: string | null;
  description: string | null;
  handle: string | null;
  mcpServers: string[];
  agentHidden: boolean;
  body: string;
};

/**
 * Parse a SKILL.md. Tolerant subset: `key: value` lines inside a leading
 * `---` fence; `mcp-servers: [a, b]` inline lists; unknown keys ignored
 * (forward compatibility with community skills carrying extra fields).
 * Returns null when there is no frontmatter fence at all.
 */
export function parseSkillMd(text: string): ParsedFrontmatter | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const raw = m[1]!;
  const body = (m[2] ?? "").replace(/^\r?\n/, "");
  let name: string | null = null;
  let description: string | null = null;
  let handle: string | null = null;
  let mcpServers: string[] = [];
  let agentHidden = false;
  for (const line of raw.split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    const value = kv[2]!.trim();
    if (key === "name") name = value || null;
    else if (key === "description") description = value || null;
    else if (key === "handle") handle = value || null;
    else if (key === "agent") agentHidden = /^(false|no|hidden)$/i.test(value);
    else if (key === "mcp-servers" || key === "mcp_servers" || key === "mcpServers") {
      const inner = /^\[(.*)\]$/.exec(value);
      const list = (inner ? inner[1]! : value)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      mcpServers = list;
    }
  }
  return { name, description, handle, mcpServers, agentHidden, body };
}

/** Serialize a draft to full SKILL.md text (mirror of parseSkillMd). */
export function serializeSkillMd(draft: SkillDraft): string {
  const lines = ["---"];
  lines.push(`name: ${draft.name}`);
  // Keep the description on ONE line (the parser's subset); strip newlines.
  lines.push(`description: ${draft.description.replace(/\r?\n/g, " ").trim()}`);
  const handle = draft.handle?.trim() || draft.name;
  if (handle && handle !== draft.name) lines.push(`handle: ${handle}`);
  if (draft.mcpServers && draft.mcpServers.length > 0)
    lines.push(`mcp-servers: [${draft.mcpServers.join(", ")}]`);
  if (draft.agentHidden) lines.push(`agent: false`);
  lines.push("---", "");
  return `${lines.join("\n")}\n${draft.content.trim()}\n`;
}

// ── IO adapters (raw invoke; workspace=null = host-local paths) ────────────

type DirEntryLite = { name: string; kind: string };

async function ioReadDir(path: string, workspace: WorkspaceEnv | null) {
  try {
    return await invoke<DirEntryLite[]>("fs_read_dir", {
      path,
      showHidden: false,
      workspace,
    });
  } catch {
    return null; // dir absent (fresh install / project without skills)
  }
}

async function ioReadFile(path: string, workspace: WorkspaceEnv | null) {
  try {
    const r = await invoke<{ kind: string; content?: string }>("fs_read_file", {
      path,
      workspace,
      extract: false,
    });
    return r.kind === "text" ? (r.content ?? null) : null;
  } catch {
    return null;
  }
}

async function ioWriteFile(path: string, content: string, workspace: WorkspaceEnv | null) {
  await invoke<void>("fs_write_file", { path, content, workspace });
}

async function ioCreateDir(path: string, workspace: WorkspaceEnv | null) {
  try {
    await invoke<void>("fs_create_dir", { path, workspace });
  } catch {
    // "already exists" or parents exist — both fine.
  }
}

async function ioDelete(path: string, workspace: WorkspaceEnv | null) {
  try {
    await invoke<void>("fs_delete", { path, workspace });
  } catch {
    // best-effort
  }
}

// ── Locations ──────────────────────────────────────────────────────────────

let globalSkillsRootCache: string | null = null;

/** `~/.kai/skills` (forward slashes; created on demand by the store). */
export async function globalSkillsRoot(): Promise<string> {
  if (globalSkillsRootCache) return globalSkillsRootCache;
  const home = (await homeDir()).replace(/\\/g, "/");
  globalSkillsRootCache = `${home}/.kai/skills`;
  return globalSkillsRootCache;
}

/** `<projectRoot>/.kai/skills`. */
export function projectSkillsRoot(projectRoot: string): string {
  return `${projectRoot.replace(/[\\/]+$/, "")}/.kai/skills`;
}

// ── Scanning ───────────────────────────────────────────────────────────────

/**
 * Scan one skills root. Directories without a parseable SKILL.md (or
 * missing name/description) are skipped — a folder dropped in by hand with
 * a bad frontmatter never breaks the picker.
 */
export async function scanSkills(
  root: string,
  scope: SkillScope,
  workspace: WorkspaceEnv | null,
): Promise<Skill[]> {
  const entries = await ioReadDir(root, workspace);
  if (!entries) return [];
  const out: Skill[] = [];
  for (const entry of entries) {
    if (entry.kind !== "dir") continue;
    const name = entry.name;
    if (!isValidSkillName(name)) continue;
    const dir = `${root}/${name}`;
    const skillMdPath = `${dir}/SKILL.md`;
    const text = await ioReadFile(skillMdPath, workspace);
    if (text == null) continue;
    const parsed = parseSkillMd(text);
    if (!parsed || !parsed.name || !parsed.description) continue;
    out.push({
      name: parsed.name,
      handle: parsed.handle && isValidHandle(parsed.handle) ? parsed.handle : parsed.name,
      description: parsed.description,
      content: parsed.body.trim(),
      mcpServers: parsed.mcpServers,
      agentHidden: parsed.agentHidden,
      scope,
      dir,
      skillMdPath,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ── Writing ────────────────────────────────────────────────────────────────

/** A skill folder "exists" when its SKILL.md parses. */
export async function skillExists(
  root: string,
  name: string,
  workspace: WorkspaceEnv | null,
): Promise<boolean> {
  const text = await ioReadFile(`${root}/${name}/SKILL.md`, workspace);
  return text != null && parseSkillMd(text) != null;
}

/** Write (create or overwrite) a skill folder. Returns the SKILL.md path. */
export async function writeSkill(
  root: string,
  draft: SkillDraft,
  workspace: WorkspaceEnv | null,
  extraFiles?: Array<{ filename: string; content: string }>,
): Promise<string> {
  if (!isValidSkillName(draft.name)) {
    throw new Error(`invalid skill name "${draft.name}" — lowercase kebab only`);
  }
  const dir = `${root}/${draft.name}`;
  await ioCreateDir(dir, workspace);
  if (extraFiles && extraFiles.length > 0) {
    await ioCreateDir(`${dir}/scripts`, workspace);
    for (const f of extraFiles) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(f.filename)) {
        throw new Error(`invalid script filename "${f.filename}"`);
      }
      await ioWriteFile(`${dir}/scripts/${f.filename}`, f.content, workspace);
    }
  }
  const skillMdPath = `${dir}/SKILL.md`;
  await ioWriteFile(skillMdPath, serializeSkillMd(draft), workspace);
  return skillMdPath;
}

/** Remove a skill (its SKILL.md — the folder is skipped once that's gone). */
export async function deleteSkill(
  root: string,
  name: string,
  workspace: WorkspaceEnv | null,
): Promise<void> {
  const dir = `${root}/${name}`;
  const entries = await ioReadDir(dir, workspace);
  if (entries) {
    for (const e of entries) {
      if (e.kind === "dir") {
        const sub = await ioReadDir(`${dir}/${e.name}`, workspace);
        if (sub) {
          for (const s of sub) {
            if (s.kind === "file") await ioDelete(`${dir}/${e.name}/${s.name}`, workspace);
          }
        }
      } else if (e.kind === "file") {
        await ioDelete(`${dir}/${e.name}`, workspace);
      }
    }
  }
  await ioDelete(`${dir}/SKILL.md`, workspace);
}

// ── Composer expansion (#handle — the legacy snippet contract) ─────────────

/**
 * Merge global + project skills for a workspace. Project wins on a name
 * collision (it shadows the global one for that repo).
 */
export function mergeSkills(global: readonly Skill[], project: readonly Skill[]): Skill[] {
  const byName = new Map(global.map((s) => [s.name, s]));
  for (const s of project) byName.set(s.name, s);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export type ExpandedSkills = {
  body: string;
  blocks: string[];
  mcpServers: string[];
  matched: Skill[];
};

/**
 * Replace `#handle` tokens in `text` with their skill bodies, wrapped in
 * `<skill name="…">…</skill>` blocks (prepend ahead of the message; the
 * composer assembles). Unknown tokens stay as-is. Collects MCP server ids
 * from every matched skill so the submit path can activate them.
 */
export function expandSkillTokens(
  text: string,
  skills: readonly Skill[],
): ExpandedSkills {
  const byHandle = new Map(skills.map((s) => [s.handle, s]));
  const matched = new Map<string, Skill>();
  // (^|\s)#handle — handle is [a-z0-9][a-z0-9-]*
  const re = /(^|\s)#([a-z0-9][a-z0-9-]*)\b/gi;
  const body = text.replace(re, (full, lead: string, raw: string) => {
    const h = raw.toLowerCase();
    const skill = byHandle.get(h);
    if (!skill) return full;
    matched.set(skill.name, skill);
    return lead;
  });
  const blocks = Array.from(matched.values()).map(
    (s) => `<skill name="${s.handle}">\n${s.content}\n</skill>`,
  );
  const mcpIds = new Set<string>();
  for (const s of matched.values()) {
    for (const id of s.mcpServers) mcpIds.add(id);
  }
  return {
    body: body.replace(/[ \t]+\n/g, "\n").trim(),
    blocks,
    mcpServers: [...mcpIds],
    matched: [...matched.values()],
  };
}

// ── Legacy snippet migration (kai-snippets.json → folders) ─────────────────

/** The legacy store shape — read-only, for the one-time migration. */
export type LegacySnippet = {
  id?: string;
  handle: string;
  name: string;
  description: string;
  content: string;
  mcpServerIds?: string[];
  builtin?: boolean;
};

/** Map one legacy snippet to a skill draft (name = handle, content kept). */
export function legacySnippetToDraft(snippet: LegacySnippet): SkillDraft {
  const handle = normalizeHandle(snippet.handle || snippet.name);
  return {
    name: handle,
    handle,
    description: snippet.description || snippet.name,
    content: snippet.content,
    mcpServers: snippet.mcpServerIds ?? [],
  };
}

// ── Factory seeds (fresh installs; re-seeded when missing, like the old
// snippet system re-added missing builtins on hydrate) ─────────────────────

export const BUILTIN_SKILLS: readonly SkillDraft[] = [
  {
    name: "analyze",
    handle: "analyze",
    description: "Understand project codebase and architecture.",
    content:
      "Familiarize yourself with the project and understand the codebase, architecture and flow.",
  },
  {
    name: "creative",
    handle: "creative",
    description: "Generate diverse, forward-thinking ideas across multiple dimensions.",
    content: [
      "You are a creative development assistant tasked with exploring innovative solutions for a new project.",
      "Your goal is to generate diverse, forward-thinking ideas across multiple dimensions of software design and implementation.",
      "",
      "Objectives:",
      "1. **Explore Diverse Solutions**: Propose multiple approaches. Include both conventional and unconventional ideas. Consider trade-offs in scalability, performance, and maintainability.",
      "2. **Support Multiple Technology Stacks**: Suggest at least 3 distinct tech stacks. Highlight strengths, weaknesses, and ideal use cases. Include emerging or experimental technologies if relevant.",
      "3. **Architectural Variations**: Present different architectural models (monolith, microservices, serverless, event-driven). Explain how each shapes development and deployment. Consider modularity, fault tolerance, and team structure.",
      "4. **UX Pattern Experimentation**: Recommend multiple UX/UI paradigms. Explore accessibility, responsiveness, and engagement strategies. Include wireframe concepts or layout ideas if possible.",
      "5. **Creative Constraints**: You may bend traditional rules to spark innovation. Combine stacks, hybridize architectures, or invent new UX metaphors. Justify each idea with reasoning and potential impact.",
      "",
      "Deliverables:",
      "- 3 creative solution paths",
      "- Comparison of tech stacks and architectures",
      "- UX pattern sketches or descriptions",
      "- A recommendation for the most promising direction, with rationale",
      "",
      'Begin by asking: "What problem are we solving?" Then explore freely.',
    ].join("\n"),
  },
  {
    name: "builder",
    handle: "builder",
    description: "Turn a rough idea into an iron-clad work order with a structured protocol.",
    content: [
      "You are Advanced Human Intent Translator MAX",
      "",
      "MISSION",
      "Turn my rough idea into an iron-clad work order, then deliver the work only after both of us agree it's right.",
      "",
      "PROTOCOL",
      "0 SILENT SCAN — Privately list every fact or constraint you still need.",
      "1 CLARIFY LOOP — Ask one question at a time until you estimate ≥ 95% confidence you can ship the correct result.",
      "  Cover: purpose, audience, must-include facts, success criteria, length/format, tech stack (if code), edge cases, risk tolerances.",
      "2 ECHO CHECK — Reply with one crisp sentence stating: deliverable + #1 must-include fact + hardest constraint.",
      "  End with: YES to lock / ❌ EDITS / ▲ BLUEPRINT / ▲ RISK. WAIT.",
      "3 ▲ BLUEPRINT (if asked) — Produce a short plan: key steps, interface or outline, sample I/O or section headers. Pause for YES / EDITS / RISK.",
      "4 ▲ RISK (if asked) — List the top three failure scenarios (logic, legal, security, perf). Pause for YES / EDITS.",
      "5 BUILD & SELF-TEST",
      "  Generate code / copy / analysis only after YES-GO.",
      "  If code: run static self-review for type errors & obvious perf hits; if prose: check tone & fact alignment.",
      "  Fix anything you find, then deliver.",
      "6 RESET — If I type RESET, forget everything and restart at Step 0.",
      "",
      'Respond once with: "Ready — what do you need?"',
    ].join("\n"),
  },
  {
    name: "trends",
    handle: "trends",
    description: "Compare search interest across keywords via pytrends (free, unofficial).",
    content: [
      "Answer the user's question with real Google Trends data via pytrends.",
      "",
      "SETUP (once): if the import fails, `pip install pytrends` (or `python -m pip install pytrends`) and retry.",
      "",
      "PATTERN:",
      '  from pytrends.request import TrendReq',
      '  pytrends = TrendReq(hl="en-US", tz=0)',
      '  pytrends.build_payload(["term a", "term b"], timeframe="today 12-m")',
      "  df = pytrends.interest_over_time()",
      "  print(df.to_csv())",
      "",
      "Write the script to a temp file, run it, read the CSV back, then answer from the numbers.",
      "",
      "PARAMETERS: timeframes `today 12-m`, `today 5-y`, `all`; geo is ISO-2 (\"US\", empty = worldwide);",
      "max 5 terms per call. related_queries() gives top+rising; interest_by_region() gives a geo breakdown.",
      "",
      "IF the `pip install` is DENIED by the agent network policy (Settings → Security, LAN-only mode):",
      "say so and STOP — do not retry the same denied command (the approval card was a real refusal).",
      "",
      "CAVEATS (state these to the user):",
      "- Unofficial API — on HTTP 429, sleep 60s and retry ONCE, then say so.",
      "- Interest is a 0-100 INDEX per term, not absolute volume: compare shapes across terms,",
      "  never sum or average terms. Low-volume terms read as flat zeros — that means \"insignificant\", not \"zero\".",
      "- No SLA: if Google breaks the endpoint, report the failure honestly instead of guessing.",
    ].join("\n"),
  },
];
