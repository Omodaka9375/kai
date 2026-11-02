/**
 * Agent skill-authoring + discovery tools (2026-11-02).
 *
 * DESIGN CONTRACTS (from the user discussion — these are load-bearing):
 *
 *  1. NO SPAM: create_skill/update_skill are ONLY for when the user
 *     explicitly asks to create a skill, or points the agent at a
 *     repository/folder/document and says to turn it into one. The tool
 *     descriptions say so in so many words, and there is NO proactive
 *     "want me to save this as a skill?" language anywhere. The previous
 *     attempt elsewhere burned users with false-positive offers on
 *     perfectly ordinary complicated queries.
 *
 *  2. PULL, NEVER PUSH: list_skills returns name/description/handle/path
 *     metadata ONLY — never bodies. Nothing skill-shaped enters the
 *     system prompt; the per-request cost is constant no matter how large
 *     the library grows. The agent reads a SKILL.md via read_file only
 *     when it is actually about to use that skill.
 *
 *  3. NO EXECUTION PRIMITIVE: a skill has no runtime of its own. Using
 *     one = read_file the SKILL.md + (optionally) bash_run its scripts
 *     under the normal approval tiers. A skill can never escalate.
 *
 *  4. APPROVAL-GATED WRITES: both authoring tools are needsApproval —
 *     the card shows the exact files about to be written, and the names
 *     are constrained to the kebab alphabet so writes can only land
 *     inside the two skills roots.
 *
 * Tool declarations use PROPERTY style (`create_skill: tool({`) so the
 * KAI.md drift gate's registry scan sees them (it matches
 * /^ {2,4}([a-z_0-9]+):\s*tool\(/ — const-declared tools are invisible
 * to it).
 */

import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context";
import {
  globalSkillsRoot,
  isValidSkillName,
  isValidHandle,
  normalizeHandle,
  projectSkillsRoot,
  scanSkills,
  skillExists,
  writeSkill,
  type SkillDraft,
} from "../lib/skills";
import { currentWorkspaceEnv } from "@/modules/workspace/env";

/** Char cap for the instructions body — a SKILL.md is a procedure, not a book. */
const CONTENT_MAX_CHARS = 24_000;

type Env = ReturnType<typeof currentWorkspaceEnv> | null;

function invalidNameError(name: string): string | null {
  if (!isValidSkillName(name)) {
    return `Invalid skill name "${name}" — lowercase letters, digits, and dashes only (e.g. "deploy-status").`;
  }
  return null;
}

export function buildSkillTools(ctx: ToolContext) {
  /** Resolve the target root for a scope. */
  const resolveRoot = async (scope: "global" | "project"): Promise<{ root: string | null; workspace: Env }> => {
    if (scope === "global") {
      return { root: await globalSkillsRoot(), workspace: null };
    }
    const projectRoot = ctx.getRealWorkspaceRoot?.() ?? ctx.getWorkspaceRoot();
    if (!projectRoot) return { root: null, workspace: null };
    return {
      root: projectSkillsRoot(projectRoot),
      workspace: currentWorkspaceEnv(),
    };
  };

  const activeProjectRoot = () =>
    ctx.getRealWorkspaceRoot?.() ?? ctx.getWorkspaceRoot();

  return {
    create_skill: tool({
      needsApproval: true,
      description:
        "Create a reusable SKILL (a SKILL.md folder the user can invoke with #handle in the composer and future agents can discover). ONLY call this when the user EXPLICITLY asks you to create/save a skill, or points you at a repository, folder, or document and tells you to turn it into a skill. NEVER offer to create a skill on your own — a normal complicated request is NOT a skill request. The user reviews the exact files on the approval card.",
      inputSchema: z.object({
        name: z
          .string()
          .describe("Kebab-case folder + handle name, e.g. \"deploy-status\". Lowercase letters, digits, dashes."),
        description: z
          .string()
          .max(1024)
          .describe("One line: what the skill does and when to use it. This is the ONLY text list_skills ever returns — make it precise."),
        instructions: z
          .string()
          .min(1)
          .max(CONTENT_MAX_CHARS)
          .describe("The SKILL.md body: step-by-step instructions a future agent follows. Plain markdown, no frontmatter."),
        handle: z
          .string()
          .optional()
          .describe("Composer #handle if it should differ from name. Defaults to name."),
        scope: z
          .enum(["global", "project"])
          .optional()
          .describe("global = every project, survives restarts (\"save to KAI permanently\"). project = this repo only (.kai/skills/, committable). Default: global."),
        scripts: z
          .array(z.object({
            filename: z.string().max(120),
            content: z.string().max(48_000),
          }))
          .max(6)
          .optional()
          .describe("Optional helper scripts saved under scripts/ in the skill folder (run later via bash_run with the normal approvals)."),
        mcp_servers: z
          .array(z.string())
          .max(8)
          .optional()
          .describe("Optional MCP server ids activated when this skill is invoked via #handle."),
      }),
      execute: async ({ name, description, instructions, handle, scope: scopeArg, scripts, mcp_servers }) => {
        const nameErr = invalidNameError(name);
        if (nameErr) return { error: nameErr };
        if (handle && !isValidHandle(handle)) {
          return { error: `Invalid handle "${handle}" — lowercase letters, digits, and dashes only.` };
        }
        const scope = scopeArg ?? "global";
        const { root, workspace } = await resolveRoot(scope);
        if (!root) {
          return { error: "No project open — use scope \"global\", or open the project first." };
        }
        if (await skillExists(root, name, workspace)) {
          return {
            error: `A skill named "${name}" already exists in the ${scope} scope. Use update_skill to change it, or pick a different name.`,
          };
        }
        const draft: SkillDraft = {
          name,
          handle: handle ? normalizeHandle(handle) : name,
          description: description.trim(),
          content: instructions.trim(),
          mcpServers: mcp_servers ?? [],
        };
        try {
          const skillMdPath = await writeSkill(
            root,
            draft,
            workspace,
            scripts?.map((s) => ({ filename: s.filename, content: s.content })),
          );
          return {
            ok: true,
            scope,
            skillMdPath,
            handle: draft.handle,
            note:
              `Skill "${name}" created in the ${scope} scope. The user can now type #${draft.handle} in the composer.` +
              (scripts?.length ? ` ${scripts.length} script(s) saved under scripts/.` : ""),
          };
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      },
    }),

    update_skill: tool({
      needsApproval: true,
      description:
        "Update an EXISTING skill's SKILL.md (description and/or instructions) — only when the user explicitly asks for the change. Same no-proactive-offer rule as create_skill: never suggest updating a skill on your own.",
      inputSchema: z.object({
        name: z.string().describe("Existing skill folder name (see list_skills)."),
        description: z.string().max(1024).optional(),
        instructions: z.string().max(CONTENT_MAX_CHARS).optional(),
        scope: z.enum(["global", "project"]).optional().describe("Which scope the skill lives in (default: search both, project wins)."),
      }),
      execute: async ({ name, description, instructions, scope: scopeArg }) => {
        const nameErr = invalidNameError(name);
        if (nameErr) return { error: nameErr };
        if (!description && !instructions) {
          return { error: "Nothing to update — provide description and/or instructions." };
        }
        // Find the skill (scope optional — project shadows global).
        const projectRoot = activeProjectRoot();
        const candidates: Array<{ root: string; workspace: Env; scope: "global" | "project" }> = [];
        if (!scopeArg || scopeArg === "project") {
          if (projectRoot) {
            candidates.push({ root: projectSkillsRoot(projectRoot), workspace: currentWorkspaceEnv(), scope: "project" });
          }
        }
        if (!scopeArg || scopeArg === "global") {
          candidates.push({ root: await globalSkillsRoot(), workspace: null, scope: "global" });
        }
        for (const c of candidates) {
          if (!(await skillExists(c.root, name, c.workspace))) continue;
          const existingList = await scanSkills(c.root, c.scope, c.workspace);
          const existing = existingList.find((s) => s.name === name);
          const draft: SkillDraft = {
            name,
            handle: existing?.handle ?? name,
            description: (description ?? existing?.description ?? "").trim(),
            content: (instructions ?? existing?.content ?? "").trim(),
            mcpServers: existing?.mcpServers ?? [],
            agentHidden: existing?.agentHidden,
          };
          if (!draft.description || !draft.content) {
            return { error: "Refusing to write an empty description or instructions body." };
          }
          try {
            const skillMdPath = await writeSkill(c.root, draft, c.workspace);
            return { ok: true, scope: c.scope, skillMdPath };
          } catch (e) {
            return { error: e instanceof Error ? e.message : String(e) };
          }
        }
        return { error: `No skill named "${name}" found${projectRoot ? " in this project or globally" : " globally"}.` };
      },
    }),

    list_skills: tool({
      needsApproval: false,
      description:
        "List available skills (reusable saved capabilities). Returns each skill's name, description, #handle, and SKILL.md path — METADATA ONLY, never the instructions. Filter with a query if you are looking for something specific; call read_file on the skillMdPath ONLY when you are about to use that skill. Skills the user invokes with #handle arrive in the message directly — you do not need this tool for those.",
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe("Optional filter — matches name, handle, or description (case-insensitive substring)."),
      }),
      execute: async ({ query }) => {
        const projectRoot = activeProjectRoot();
        const globalRoot = await globalSkillsRoot();
        const global = await scanSkills(globalRoot, "global", null);
        const project = projectRoot
          ? await scanSkills(projectSkillsRoot(projectRoot), "project", currentWorkspaceEnv())
          : [];
        const byName = new Map(global.map((s) => [s.name, s]));
        for (const s of project) byName.set(s.name, s); // project wins
        let all = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
        // agent: false skills are handle-only — hidden from agent discovery.
        all = all.filter((s) => !s.agentHidden);
        if (query?.trim()) {
          const q = query.trim().toLowerCase();
          all = all.filter(
            (s) =>
              s.name.toLowerCase().includes(q) ||
              s.handle.toLowerCase().includes(q) ||
              s.description.toLowerCase().includes(q),
          );
        }
        return {
          skills: all.map((s) => ({
            name: s.name,
            handle: s.handle,
            description: s.description,
            scope: s.scope,
            skillMdPath: s.skillMdPath,
          })),
          total: all.length,
          note:
            "Read a skill's SKILL.md (read_file) only when you are about to use it. To create or change a skill, the user must explicitly ask.",
        };
      },
    }),
  } as const;
}
