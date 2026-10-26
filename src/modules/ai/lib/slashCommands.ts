import {
  CheckListIcon,
  SparklesIcon,
  ArrowShrink01Icon,
} from "@hugeicons/core-free-icons";
import { usePlanStore } from "../store/planStore";

/**
 * Outcome of intercepting a slash command from the composer.
 *
 * - `"handled"`: command ran; the composer should NOT send a chat message.
 * - `"send-prompt"`: replace the user's text with `prompt` and send normally.
 * - `"none"`: not a slash command; let the composer behave as usual.
 */
export type SlashOutcome =
  | { kind: "handled"; toast?: string }
  | { kind: "send-prompt"; prompt: string; commandName?: string }
  | { kind: "none" };

// Relationship-first rewrite (inspired by codebase knowledge-graph tools).
// The map's whole value is letting a FUTURE session answer structural
// questions without re-grepping, so it must capture cross-file EDGES and
// data-flow PATHS, not prose summaries. Filename is KAI.md (uppercase) to
// match projectRules.ts's `const KAI_MD = "KAI.md"` — the previous "Kai.md"
// casing made /init write a file that's never loaded on case-sensitive
// filesystems (Linux); Win/macOS hid the bug.
const INIT_PROMPT = `You are building KAI's persistent codebase map: a file named exactly KAI.md at the workspace root. This file is auto-loaded into EVERY future session's context, so its job is to let a later agent answer "how does X connect to Y" / "where is Z" WITHOUT re-grepping the repo. Optimize for relationships, not narration — every line must earn its share of the context window.

STEP 1 — Refresh, don't clobber. read_file KAI.md first. If it already exists, UPDATE it: keep what's still true, fix what moved, PRESERVE any hand-written notes and anything marked AMBIGUOUS, and refresh the date stamp. If it doesn't exist, create it.

STEP 2 — Explore, delegating the heavy sweep. For any non-trivial repo, call run_subagent(type="explore") once to map entry points, module boundaries, and the key cross-file symbols with their callers/callees; use grep/glob/list_directory/read_file only to spot-check. Read real code for every load-bearing node — do not invent APIs, paths, or edges.

STEP 3 — write_file KAI.md (goes through normal approval) in this shape:

# <project name>
<generated: today's date · refresh with /init · re-verify a path before trusting it if the tree has moved>

## What this is
One short paragraph: purpose + primary language / framework / runtime.

## Run it
Exact build / dev / test / typecheck / lint command strings, copied verbatim from package.json / Cargo.toml / Makefile / CI.

## Architecture map
Group the code into subsystems (the natural clusters). One purpose-line per subsystem, then its key nodes. For each load-bearing node record the EDGES — this is the point:
    <path>:<symbol>  — provides <what> · depends-on <who> · used-by <who>
List a symbol edge only when it crosses a subsystem boundary or a future agent would otherwise have to hunt for it. Tag non-obvious edges (INFERRED) when deduced from naming/convention and (AMBIGUOUS) when unconfirmed, so later agents know what to re-check vs trust.

## Data flow / entry points
2–5 traversable paths from an entry point through the main stages (e.g. request → handler → service → store → response), each as an arrow-chain of real file:symbol references.

## Central nodes
The 3–8 highest fan-in modules/symbols (most depended-on). Editing these is risky — naming them front-and-center makes agents think twice.

## Conventions & gotchas
The non-obvious rules an agent must follow or gets bitten by: exact path forms, naming/pattern requirements, footguns, platform quirks. Phrase as "do X / never Y because Z".

## Where to look
A quick index for the questions agents actually ask ("where is auth", "how are tools registered", "where's persistence") → the file path(s), preferring path:symbol over vague descriptions.

Ground every claim in code you read this session. Prefer real symbols and paths over prose descriptions of them.`;

export type SlashCommandMeta = {
  name: string;
  invocation: string;
  label: string;
  icon: typeof SparklesIcon;
};

export const SLASH_COMMANDS: Record<string, SlashCommandMeta> = {
  init: {
    name: "init",
    invocation: "/init",
    label: "Initialize workspace",
    icon: SparklesIcon,
  },
  plan: {
    name: "plan",
    invocation: "/plan",
    label: "Plan mode",
    icon: CheckListIcon,
  },
  compact: {
    name: "compact",
    invocation: "/compact",
    label: "Compress context in place",
    icon: ArrowShrink01Icon,
  },
};

export const Kai_CMD_RE =
  /^<Kai-command\s+name="([a-z0-9-]+)"(?:\s+state="([a-z]+)")?\s*\/>(?:\n+|$)/;

export function wrapWithCommandMarker(prompt: string, name: string): string {
  return `<Kai-command name="${name}" />\n\n${prompt}`;
}

export async function tryRunSlashCommand(input: string): Promise<SlashOutcome> {
  const trimmed = input.trim();
  const lead = trimmed[0];
  if (lead !== "/" && lead !== "#") return { kind: "none" };
  const [head, ...rest] = trimmed.slice(1).split(/\s+/);
  if (lead === "#" && !SLASH_COMMANDS[head]) return { kind: "none" };
  const tail = rest.join(" ").trim();

  switch (head) {
    case "plan": {
      const store = usePlanStore.getState();
      if (tail === "off" || tail === "exit") {
        store.disable();
        return { kind: "handled", toast: "Plan mode off" };
      }
      store.toggle();
      const nowActive = usePlanStore.getState().active;
      return {
        kind: "handled",
        toast: nowActive ? "Plan mode on" : "Plan mode off",
      };
    }
    case "init": {
      return {
        kind: "send-prompt",
        prompt: INIT_PROMPT,
        commandName: "init",
      };
    }
    case "compact": {
      // In-place context compaction — same chat continues with a
      // <session_state> snapshot + recent tail instead of the full history.
      // Refuses while busy; the toast carries the outcome either way.
      const { useChatStore } = await import("../store/chatStore");
      const result = useChatStore.getState().compactActiveSession();
      return { kind: "handled", toast: result };
    }
    default:
      return { kind: "none" };
  }
}
