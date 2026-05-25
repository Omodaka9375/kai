import { LazyStore } from "@tauri-apps/plugin-store";

export type Snippet = {
  id: string;
  /** The "#handle" used in the composer. Lowercase, [a-z0-9-]+. */
  handle: string;
  name: string;
  description: string;
  content: string;
  /** Optional MCP server IDs to activate when this skill is used. */
  mcpServerIds?: string[];
  /** True for factory-shipped snippets. */
  builtin?: boolean;
};

const STORE_PATH = "kai-snippets.json";
const KEY_LIST = "snippets";

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

export async function loadSnippets(): Promise<Snippet[]> {
  return (await store.get<Snippet[]>(KEY_LIST)) ?? [];
}

export async function saveSnippets(list: Snippet[]): Promise<void> {
  await store.set(KEY_LIST, list);
  await store.save();
}

export function newSnippetId(): string {
  return `sn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

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

/** Factory-shipped snippets seeded on first launch. */
export const BUILTIN_SNIPPETS: readonly Snippet[] = [
  {
    id: "builtin-analyze",
    handle: "analyze",
    name: "Analyze Codebase",
    description: "Understand project codebase and architecture.",
    content:
      "Familiarize yourself with the project and understand the codebase, architecture and flow.",
    builtin: true,
  },
  {
    id: "builtin-creative",
    handle: "creative",
    name: "Creative Exploration",
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
    builtin: true,
  },
  {
    id: "builtin-intent",
    handle: "builder",
    name: "Idea Builder",
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
    builtin: true,
  },
];

/**
 * Replace `#handle` tokens in `text` with their snippet bodies, wrapped in
 * `<snippet name="…">…</snippet>` blocks, prepended to the message. Tokens that
 * don't match a known snippet are left as-is.
 *
 * Returns the rewritten body (with tokens stripped) and the list of expanded
 * snippet blocks to prepend.
 */
export function expandSnippetTokens(
  text: string,
  snippets: readonly Snippet[],
): { body: string; blocks: string[]; mcpServerIds: string[] } {
  const byHandle = new Map(snippets.map((s) => [s.handle, s]));
  const matched = new Map<string, Snippet>();
  // (^|\s)#handle  — handle is [a-z0-9][a-z0-9-]*
  const re = /(^|\s)#([a-z0-9][a-z0-9-]*)\b/gi;
  const body = text.replace(re, (full, lead: string, raw: string) => {
    const h = raw.toLowerCase();
    const snip = byHandle.get(h);
    if (!snip) return full;
    matched.set(snip.id, snip);
    return lead;
  });
  const blocks = Array.from(matched.values()).map(
    (s) => `<snippet name="${s.handle}">\n${s.content}\n</snippet>`,
  );
  // Collect MCP server IDs from all matched skills.
  const mcpIds = new Set<string>();
  for (const s of matched.values()) {
    if (s.mcpServerIds) {
      for (const id of s.mcpServerIds) mcpIds.add(id);
    }
  }
  return {
    body: body.replace(/[ \t]+\n/g, "\n").trim(),
    blocks,
    mcpServerIds: [...mcpIds],
  };
}
