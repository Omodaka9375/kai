import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_SKILLS,
  expandSkillTokens,
  isValidHandle,
  isValidSkillName,
  legacySnippetToDraft,
  mergeSkills,
  normalizeHandle,
  parseSkillMd,
  serializeSkillMd,
  type Skill,
} from "./skills";

/**
 * Skills system contract (2026-11-02) — the unified artifact replacing
 * snippets, Anthropic-SKILL.md compatible.
 *
 * Design decisions under test (from the user discussion):
 *  - #handle expansion keeps working in ANY project (plug-and-play);
 *  - the agent path is PULL-ONLY: list_skills returns metadata, bodies
 *    enter context only via an explicit read_file — the per-request cost
 *    is constant regardless of library size;
 *  - creation is human-gated (approval tools; no proactive offers);
 *  - `agent: false` hides a skill from agent discovery (handle-only).
 */

// ── Handle / name helpers (carried over from the snippet system) ───────────

describe("normalizeHandle / isValidHandle / isValidSkillName", () => {
  it("normalizes like the legacy snippet handles did", () => {
    expect(normalizeHandle("My Handle")).toBe("my-handle");
    expect(normalizeHandle("hello@world!")).toBe("helloworld");
    expect(normalizeHandle("a--b---c")).toBe("a-b-c");
    expect(normalizeHandle("-test-")).toBe("test");
  });

  it("validates the kebab alphabet", () => {
    expect(isValidHandle("my-skill")).toBe(true);
    expect(isValidHandle("")).toBe(false);
    expect(isValidHandle("-test")).toBe(false);
    expect(isValidHandle("MySkill")).toBe(false);
    expect(isValidSkillName("deploy-status")).toBe(true);
    expect(isValidSkillName("Deploy Status")).toBe(false);
  });
});

// ── Frontmatter round-trip ──────────────────────────────────────────────────

describe("parseSkillMd / serializeSkillMd", () => {
  it("round-trips a full skill", () => {
    const draft = {
      name: "deploy-status",
      handle: "deploy",
      description: "Check the deploy pipeline status.",
      content: "# Deploy\n\n1. Run the status check.",
      mcpServers: ["linear", "github"],
      agentHidden: true,
    };
    const text = serializeSkillMd(draft);
    const parsed = parseSkillMd(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe("deploy-status");
    expect(parsed!.description).toBe("Check the deploy pipeline status.");
    expect(parsed!.handle).toBe("deploy");
    expect(parsed!.mcpServers).toEqual(["linear", "github"]);
    expect(parsed!.agentHidden).toBe(true);
    expect(parsed!.body).toContain("# Deploy");
  });

  it("handle defaults to name when omitted", () => {
    const text = serializeSkillMd({
      name: "analyze",
      description: "d",
      content: "body",
    });
    const parsed = parseSkillMd(text)!;
    expect(parsed.handle).toBeNull(); // not serialized when === name
    // Scan-side default: handle = name.
    expect(text).not.toContain("handle:");
  });

  it("returns null for text without a frontmatter fence", () => {
    expect(parseSkillMd("Just some markdown.")).toBeNull();
  });

  it("multi-line descriptions collapse to one line (parser subset)", () => {
    const text = serializeSkillMd({
      name: "x",
      description: "line one\nline two",
      content: "b",
    });
    expect(text).toContain("description: line one line two");
    const parsed = parseSkillMd(text)!;
    expect(parsed.description).toBe("line one line two");
  });

  it("unknown frontmatter keys are ignored (community-skill forward compat)", () => {
    const text = [
      "---",
      "name: community-skill",
      "description: d",
      "version: 1.2",
      "license: MIT",
      "---",
      "",
      "body",
    ].join("\n");
    const parsed = parseSkillMd(text)!;
    expect(parsed.name).toBe("community-skill");
    expect(parsed.body).toBe("body");
  });
});

// ── #handle expansion (the plug-and-play contract) ──────────────────────────

describe("expandSkillTokens", () => {
  const skills: Skill[] = [
    {
      name: "analyze",
      handle: "analyze",
      description: "test",
      content: "Do analysis.",
      mcpServers: [],
      agentHidden: false,
      scope: "global",
      dir: "~/.kai/skills/analyze",
      skillMdPath: "~/.kai/skills/analyze/SKILL.md",
    },
    {
      name: "creative",
      handle: "creative",
      description: "test",
      content: "Be creative.",
      mcpServers: ["server-1"],
      agentHidden: false,
      scope: "global",
      dir: "~/.kai/skills/creative",
      skillMdPath: "~/.kai/skills/creative/SKILL.md",
    },
  ];

  it("expands a single #handle into a <skill> block", () => {
    const { body, blocks, mcpServers } = expandSkillTokens(
      "Please #analyze this code",
      skills,
    );
    expect(body).toBe("Please  this code");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("<skill name=\"analyze\">");
    expect(blocks[0]).toContain("Do analysis.");
    expect(mcpServers).toEqual([]);
  });

  it("expands multiple tokens and collects MCP ids", () => {
    const { blocks, mcpServers } = expandSkillTokens(
      "#analyze and #creative",
      skills,
    );
    expect(blocks).toHaveLength(2);
    expect(mcpServers).toEqual(["server-1"]);
  });

  it("leaves unknown tokens as-is (no false expansion)", () => {
    const { body, blocks } = expandSkillTokens("#unknown token", skills);
    expect(body).toBe("#unknown token");
    expect(blocks).toHaveLength(0);
  });

  it("agentHidden skills STILL expand via #handle (hidden only from agent discovery)", () => {
    const hidden: Skill = { ...skills[0]!, name: "secret", handle: "secret", agentHidden: true };
    const { blocks } = expandSkillTokens("#secret", [...skills, hidden]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("Do analysis.");
  });
});

// ── Scope merge ─────────────────────────────────────────────────────────────

describe("mergeSkills", () => {
  it("project shadows global on name collision", () => {
    const global: Skill[] = [
      {
        name: "deploy", handle: "deploy", description: "global", content: "g",
        mcpServers: [], agentHidden: false, scope: "global", dir: "g", skillMdPath: "g",
      },
    ];
    const project: Skill[] = [
      {
        name: "deploy", handle: "deploy", description: "project", content: "p",
        mcpServers: [], agentHidden: false, scope: "project", dir: "p", skillMdPath: "p",
      },
    ];
    const merged = mergeSkills(global, project);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.scope).toBe("project");
  });

  it("keeps both when names differ", () => {
    const global: Skill[] = [
      {
        name: "a", handle: "a", description: "", content: "",
        mcpServers: [], agentHidden: false, scope: "global", dir: "", skillMdPath: "",
      },
    ];
    const project: Skill[] = [
      {
        name: "b", handle: "b", description: "", content: "",
        mcpServers: [], agentHidden: false, scope: "project", dir: "", skillMdPath: "",
      },
    ];
    expect(mergeSkills(global, project)).toHaveLength(2);
  });
});

// ── Legacy migration mapping ────────────────────────────────────────────────

describe("legacySnippetToDraft", () => {
  it("maps a snippet row to a global skill draft, handle preserved", () => {
    const draft = legacySnippetToDraft({
      handle: "My Trends!",
      name: "Google Trends",
      description: "desc",
      content: "body",
      mcpServerIds: ["s1"],
    });
    expect(draft.name).toBe("my-trends");
    expect(draft.handle).toBe("my-trends");
    expect(draft.mcpServers).toEqual(["s1"]);
    expect(draft.content).toBe("body");
  });
});

// ── Factory seeds ───────────────────────────────────────────────────────────

describe("BUILTIN_SKILLS", () => {
  it("carries the four legacy factory snippets", () => {
    expect(BUILTIN_SKILLS.length).toBeGreaterThanOrEqual(4);
    const names = BUILTIN_SKILLS.map((s) => s.name);
    expect(names).toContain("analyze");
    expect(names).toContain("creative");
    expect(names).toContain("builder");
    expect(names).toContain("trends");
  });

  it("every seed round-trips through the serializer", () => {
    for (const seed of BUILTIN_SKILLS) {
      const parsed = parseSkillMd(serializeSkillMd(seed));
      expect(parsed, `seed ${seed.name} failed to round-trip`).not.toBeNull();
      expect(parsed!.name).toBe(seed.name);
      expect(parsed!.body.length).toBeGreaterThan(10);
    }
  });
});

// ── Wiring pins (source contracts) ───────────────────────────────────────────

const composer = readFileSync(
  new URL("../components/composer.tsx", import.meta.url),
  "utf8",
);
const toolsSrc = readFileSync(
  new URL("../tools/skills.ts", import.meta.url),
  "utf8",
);
const toolsRegistry = readFileSync(
  new URL("../tools/tools.ts", import.meta.url),
  "utf8",
);
const promptSrc = readFileSync(
  new URL("../config/prompt.ts", import.meta.url),
  "utf8",
);

describe("wiring: the composer expands #handle over the skills system", () => {
  it("uses expandSkillTokens + skillsForProject (no snippet imports remain)", () => {
    expect(composer).toContain("expandSkillTokens");
    expect(composer).toContain("skillsForProject(runtime?.root)");
    expect(composer).toContain("<skill name=\"${s.handle}\">");
    expect(composer).not.toContain("expandSnippetTokens");
    expect(composer).not.toContain("lib/snippets");
  });

  it("matched skills activate their MCP servers non-interactively", () => {
    expect(composer).toContain("mcpManager.connect(cfg, false)");
  });
});

describe("wiring: the agent tool surface (pull-only, human-gated)", () => {
  it("create_skill and update_skill are approval-gated with explicit-only language", () => {
    // Property-style declarations (the KAI.md drift gate's registry regex
    // matches `name: tool(` — const-declared tools are invisible to it).
    expect(toolsSrc).toMatch(/create_skill: tool\(\{\s*\n\s*needsApproval: true,/);
    expect(toolsSrc).toMatch(/update_skill: tool\(\{\s*\n\s*needsApproval: true,/);
    // The anti-spam contract, in the tool's own description:
    expect(toolsSrc).toContain("NEVER offer to create a skill on your own");
    expect(toolsSrc).toContain("never suggest updating a skill on your own");
  });

  it("list_skills is auto-execute and returns metadata only", () => {
    expect(toolsSrc).toMatch(/list_skills: tool\(\{\s*\n\s*needsApproval: false,/);
    expect(toolsSrc).toContain("METADATA ONLY, never the instructions");
    // agentHidden skills are filtered OUT of agent discovery:
    expect(toolsSrc).toContain("all.filter((s) => !s.agentHidden)");
  });

  it("the tools are registered in buildCoreTools", () => {
    expect(toolsRegistry).toContain("buildSkillTools");
  });

  it("the system prompt carries the no-spam + pull-model guidance", () => {
    expect(promptSrc).toContain("list_skills shows saved reusable capabilities");
    expect(promptSrc).toContain("NEVER offer to create one yourself");
  });
});

describe("wiring: skills write only inside their two roots", () => {
  it("the tool resolves roots via globalSkillsRoot / projectSkillsRoot only", () => {
    expect(toolsSrc).toContain("globalSkillsRoot()");
    expect(toolsSrc).toContain("projectSkillsRoot(projectRoot)");
    // No arbitrary-path write: name must pass the kebab gate.
    expect(toolsSrc).toContain("isValidSkillName(name)");
  });
});


describe("write security (2026-11-02 review, FIX 6)", () => {
  // Review finding: the skill-authoring tools bypassed the security layer
  // entirely (no checkWritableCanonical import), and writeSkill wrote
  // THROUGH pre-planted symlinks. Two layers now guard the write path.
  const toolsSrc6 = readFileSync(
    new URL("../tools/skills.ts", import.meta.url),
    "utf8",
  );
  const libSrc6 = readFileSync(new URL("./skills.ts", import.meta.url), "utf8");

  it("the agent write path runs checkWritableCanonical before every skill write", () => {
    expect(toolsSrc6).toContain("checkWritableCanonical");
    expect(toolsSrc6).toContain("secureSkillWrite");
    // (regex-literal backslashes do not survive the tool encoding; indexOf assertions instead)
  expect(toolsSrc6.indexOf("const skillMdPath = await secureSkillWrite(")).toBeGreaterThan(
    toolsSrc6.indexOf("create_skill: tool("),
  );
    expect(toolsSrc6.indexOf("const skillMdPath = await secureSkillWrite(c.root, draft, c.workspace);")).toBeGreaterThan(
    toolsSrc6.indexOf("update_skill: tool("),
  );
    // The sandbox override follows the tool context (same as write_file).
    expect(toolsSrc6).toContain("sandboxOverrideForContext(ctx)");
  });

  it("writeSkill refuses to write through a symlink that escapes the skill folder", () => {
    expect(libSrc6).toContain("assertInsideDir");
    // The guard covers the skill dir, each script, and SKILL.md.
    expect(libSrc6).toContain("await assertInsideDir(root, dir, workspace);");
    expect(libSrc6).toContain("await assertInsideDir(dir, scriptPath, workspace);");
    expect(libSrc6).toContain("await assertInsideDir(dir, skillMdPath, workspace);");
    // Refusal message names the escape (symlink).
    expect(libSrc6).toContain("resolves outside the skill folder (symlink?)");
  });
});
