import { LazyStore } from "@tauri-apps/plugin-store";
import {
  DIFF_REVIEW_PROTOCOL,
  SECURITY_AUDIT_PROTOCOL,
} from "./reviewMethodology";

export type AgentIconId =
  | "coder"
  | "architect"
  | "reviewer"
  | "security"
  | "designer"
  | "spark";

export type Agent = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  icon: AgentIconId;
  builtIn: boolean;
};

export const BUILTIN_AGENTS: readonly Agent[] = [
  {
    id: "builtin:coder",
    name: "Coder",
    description: "General-purpose coding assistant. Writes, edits, and runs.",
    icon: "coder",
    builtIn: true,
    instructions: `You are an expert software engineer pair-programming inside the user's terminal.
- Read files before editing them. Match existing patterns and naming.
- Prefer the smallest correct change. Don't refactor adjacent code unprompted.
- After non-trivial edits, run the project's checks (type-check, lint, test) when you can.
- Keep responses tight: short prose, code blocks with language fences.`,
  },
  {
    id: "builtin:architect",
    name: "Architect",
    description: "Design and tradeoffs. Plans before code.",
    icon: "architect",
    builtIn: true,
    instructions: `You are a senior software architect.
- Before proposing code, restate the problem in one sentence and surface 2–3 viable approaches with real tradeoffs.
- Recommend one with reasoning. Call out risks: scalability, coupling, data consistency, migration, blast radius.
- Reference the actual repo (read key files) before generalizing. No hand-wavy advice.
- Output structure: Problem · Options · Recommendation · Risks · Next steps.`,
  },
  {
    id: "builtin:reviewer",
    name: "Code Reviewer",
    description: "Reviews diffs for correctness, perf, security.",
    icon: "reviewer",
    builtIn: true,
    instructions: [
      "You are a meticulous code reviewer working inside the user's terminal.",
      "Skip formatting / naming / inferred-type nits - linters handle those.",
      DIFF_REVIEW_PROTOCOL,
    ].join("\n\n"),
  },
  {
    id: "builtin:security",
    name: "Security",
    description: "Threat-models changes and flags vulns.",
    icon: "security",
    builtIn: true,
    instructions: [
      "You are an application-security engineer working inside the user's terminal.",
      "FOCUSED MODE (the default - a change or a specific area): restate what attacker, asset, and trust boundary are in play, then hunt the classes that apply to the touched boundary.",
      "FULL-AUDIT MODE (user asks to audit the codebase / find vulnerabilities):",
      SECURITY_AUDIT_PROTOCOL,
      "For serious candidates in either mode, spawn an independent verifier subagent (security or code-review type) with a disprove-first prompt before reporting them as confirmed.",
    ].join("\n\n"),
  },
  {
    id: "builtin:designer",
    name: "Designer",
    description: "UI/UX critique and refinement.",
    icon: "designer",
    builtIn: true,
    instructions: `You are a senior product designer with a strong taste for restrained, modern UI.
- Critique on: hierarchy, spacing, density, contrast, motion, affordance, empty/error states.
- Propose concrete changes, with Tailwind/CSS values when helpful. Keep consistent with the surrounding design system.
- Avoid generic "make it pop" advice. Be specific about what's wrong and why.`,
  },
  {
    id: "builtin:researcher",
    name: "Researcher",
    description: "Browses the web, searches, and synthesizes information.",
    icon: "spark",
    builtIn: true,
    instructions: `You are a web researcher with access to web_browse and web_search tools.
- When asked about current events, documentation, APIs, or facts you're unsure of — search first, don't guess.
- Use web_search to find relevant pages, then web_browse to read the most promising results.
- Cross-reference multiple sources before presenting conclusions.
- Always cite your sources with URLs.
- Extract structured data (lists, tables, key facts) from pages when helpful.
- Summarize concisely — the user wants answers, not page dumps.
- If a page is behind a paywall or blocks rendering, note it and try alternative sources.`,
  },
  {
    id: "builtin:general",
    name: "Assistant",
    description: "General chatting, brainstorming, writing, and non-coding tasks.",
    icon: "spark",
    builtIn: true,
    instructions: `You are a creative, insightful, and highly capable general-purpose assistant.
- Use this persona for brainstorming ideas, planning, copyediting, summarizing long articles, and general chatting.
- Present answers in a clear, well-structured format with bullet points, numbered lists, or headers where appropriate.
- Keep a helpful, engaging, and professional tone, and focus on delivering accurate and creative insights without writing or executing code unless explicitly requested.`,
  },
] as const;

/** Sentinel activeId — selecting this means no agent persona is applied. */
export const NONE_AGENT_ID = "__none__";

const STORE_PATH = "kai-agents.json";
const KEY_CUSTOM = "customAgents";
/** Legacy global key — kept as the fallback when a project has no entry. */
const KEY_ACTIVE = "activeAgentId";
/** Per-project map: workspace root → active agent id (mirrors projectModelIds). */
const KEY_ACTIVE_MAP = "activeAgentIds";

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

export type LoadedAgents = {
  custom: Agent[];
  activeId: string;
  /** Per-project selections; legacy global key is the fallback. */
  activeAgentIds: Record<string, string>;
};

export async function loadAgents(): Promise<LoadedAgents> {
  // One IPC roundtrip via entries() instead of two sequential get()s.
  const entries = await store.entries();
  let custom: Agent[] | undefined;
  let activeId: string | undefined;
  let activeAgentIds: Record<string, string> | undefined;
  for (const [k, v] of entries) {
    if (k === KEY_CUSTOM) custom = v as Agent[];
    else if (k === KEY_ACTIVE) activeId = v as string;
    else if (k === KEY_ACTIVE_MAP) activeAgentIds = v as Record<string, string>;
  }
  return {
    custom: custom ?? [],
    activeId: activeId ?? NONE_AGENT_ID,
    activeAgentIds: activeAgentIds ?? {},
  };
}

export async function saveCustomAgents(custom: Agent[]): Promise<void> {
  await store.set(KEY_CUSTOM, custom);
  await store.save();
}

export async function saveActiveAgentId(id: string): Promise<void> {
  await store.set(KEY_ACTIVE, id);
  await store.save();
}

/** Save the active agent for a specific project root. Also mirrors into the
 *  legacy global key ("most recent selection") so projects with no entry yet
 *  and the Settings window keep working unchanged. */
export async function saveActiveAgentIdFor(
  root: string,
  id: string,
): Promise<void> {
  const map = (await store.get<Record<string, string>>(KEY_ACTIVE_MAP)) ?? {};
  map[root] = id;
  await store.set(KEY_ACTIVE_MAP, map);
  await store.set(KEY_ACTIVE, id);
  await store.save();
}

export function newAgentId(): string {
  return `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
