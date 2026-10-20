/**
 * Path-safety guards for AI tool calls.
 *
 * Goals:
 *  - Block reads of files that almost always contain secrets (.env*, *.pem,
 *    id_rsa*, .aws/credentials, .ssh/, .git/, kube/azure config, etc.).
 *  - Block writes/exec into the same set, plus directories where automated
 *    mutation is dangerous (system dirs, Windows system dirs).
 *
 * This is a *defense layer*, not a sandbox. The model may still be coaxed
 * into doing something silly within allowed paths — the user-confirmation
 * UI for write/exec is the real safety net. These checks ensure that
 * read tools (which auto-approve) can never silently exfiltrate obvious
 * secrets, and that a single bad approval can't blow up the system.
 *
 * Defense-in-depth notes:
 *  - Comparison surface is lowercased *only for matching*. Original path is
 *    preserved for basename pattern checks and error messages.
 *  - Windows drive prefix (e.g. `C:`) is stripped from the comparison form so
 *    Unix-style root prefix checks behave consistently on both platforms.
 *  - Protected directories match exact-equal-or-descendant, not raw
 *    substring-with-trailing-slash. Bare names (`/Users/me/.ssh`) and
 *    case-variants (`/Users/me/.SSH/config` on macOS/Windows case-insensitive
 *    filesystems) are caught.
 *  - The caller is expected to additionally validate the *canonical* path
 *    (post symlink resolution) via `native.canonicalize` + a second
 *    `checkReadable` pass, since a symlink at an "innocent" path can point
 *    into a protected directory.
 */

import { auditAppend, AUDIT_KINDS } from "./audit";
import { checkSandbox } from "./sandbox";

const SECRET_BASENAME_PATTERNS: RegExp[] = [
  // Match `.env` and `.env.<suffix>` with no required tail anchor — Windows
  // strips trailing dots/spaces at open time and NTFS exposes alternate data
  // streams via `name:stream`, both of which would otherwise slip past a `$`
  // anchored pattern (`.env.`, `.env::$DATA`).
  /^\.env(\..+)?(?:[.\s:]|$)/i,
  /^.*\.pem(?:[.\s:]|$)/i,
  /^.*\.key(?:[.\s:]|$)/i, // private keys
  /^.*\.p12(?:[.\s:]|$)/i,
  /^.*\.pfx(?:[.\s:]|$)/i,
  /^.*\.asc(?:[.\s:]|$)/i, // PGP armored keys
  /^.*\.gpg(?:[.\s:]|$)/i,
  /^.*\.keystore(?:[.\s:]|$)/i,
  /^.*\.jks(?:[.\s:]|$)/i,
  // Match `id_rsa`, `id_rsa.pub`, and common backup/copy patterns like
  // `id_rsa.bak`, `id_rsa_old`, `id_rsa-backup`.
  /^id_(rsa|dsa|ecdsa|ed25519)([._-].*)?(?:[.\s:]|$)/i,
  /^known_hosts(?:[.\s:]|$)/i,
  /^authorized_keys(?:[.\s:]|$)/i,
  /^htpasswd(?:[.\s:]|$)/i,
  /^\.netrc(?:[.\s:]|$)/i,
  /^_netrc(?:[.\s:]|$)/i, // Windows variant
  /^credentials(?:[.\s:]|$)/i, // .aws/credentials, gcloud, etc.
  /^\.pgpass(?:[.\s:]|$)/i,
  /^\.npmrc(?:[.\s:]|$)/i,
  /^\.pypirc(?:[.\s:]|$)/i,
  /^secrets?\.(json|ya?ml|toml|env)(?:[.\s:]|$)/i,
  /^service[-_]?account.*\.json(?:[.\s:]|$)/i, // GCP service account keys
];

/**
 * Protected directories. Matched as **exact path** OR **prefix where the next
 * char is a separator** — never raw substring. Listed without trailing slash;
 * the comparator handles separators.
 */
const PROTECTED_DIRS = [
  // KAI's own control-plane state. The approval allowlist lives under
  // ~/.kai/allowlist/ — agent-writable it would be a self-grant: a prompt
  // injection could pin its own commands and never see an approval card
  // again. The audit dir is blocked on the write side by the same rule
  // (append-only integrity is enforced by the Rust module; here we keep
  // the agent from touching either at all).
  "/.kai/allowlist",
  "/.kai/audit",
  "/.ssh",
  "/.gnupg",
  "/.aws",
  "/.azure",
  "/.kube",
  "/.docker",
  "/.config/gh",
  "/.config/git",
  "/.config/gcloud",
  "/.config/op", // 1Password CLI
  "/.git", // git internals — refusing avoids tools mutating refs/objects
  "/.terraform.d",
  "/library/keychains",
  "/library/cookies",
  // System dirs holding host secrets/PII/process state. Per-PID files under
  // /proc leak env vars and command lines from other processes; /sys exposes
  // kernel state and hardware identifiers. /etc and /private/etc hold global
  // config that frequently contains credentials in basenames the regex won't
  // match (passwd, shadow, master.passwd, *.cnf, *.conf with creds).
  "/etc",
  "/private/etc",
  "/proc",
  "/sys",
  "/var/db",
  "/var/root",
  "/private/var/db",
  "/private/var/root",
  // Windows user profile equivalents (post drive-strip + lowercase).
  "/appdata/roaming/microsoft/credentials",
  "/appdata/local/microsoft/credentials",
  "/appdata/roaming/gcloud",
];

/**
 * Write-only deny prefixes (system locations). Read access is *not* universally
 * blocked — reading `/etc/hosts` is fine; writing to it isn't.
 */
const WRITE_DENY_PREFIXES = [
  "/etc/",
  "/var/db/",
  "/var/root/",
  "/system/", // case-folded from /System/
  "/library/keychains/",
  "/library/launchagents/",
  "/library/launchdaemons/",
  "/private/etc/",
  "/private/var/db/",
  "/usr/bin/",
  "/usr/sbin/",
  "/usr/local/bin/",
  "/bin/",
  "/sbin/",
  "/boot/",
  // Windows (post drive-strip + lowercase). Note: these block writes to the
  // system drive's Windows / Program Files. Drives are stripped, so any
  // /windows/... etc. matches regardless of drive letter.
  "/windows/",
  "/program files/",
  "/program files (x86)/",
  "/programdata/",
];

/**
 * Write-only deny-list by basename.
 *
 * These are deliberately NOT in the read list: reading `~/.bashrc` is a normal
 * request ("why isn't my alias loading?"), and refusing it would break real
 * debugging. Writing them is a different matter — shell init files and git
 * config execute arbitrary commands on your next login or git invocation, so
 * they are the classic persistence target, and they are precisely the files
 * whose *contents* the value-shaped redaction can only partly protect.
 */
const WRITE_DENY_BASENAMES: RegExp[] = [
  /^\.bashrc(?:[.\s:]|$)/i,
  /^\.bash_profile(?:[.\s:]|$)/i,
  /^\.bash_login(?:[.\s:]|$)/i,
  /^\.profile(?:[.\s:]|$)/i,
  /^\.zshenv(?:[.\s:]|$)/i,
  /^\.zprofile(?:[.\s:]|$)/i,
  /^\.zshrc(?:[.\s:]|$)/i,
  /^\.zlogin(?:[.\s:]|$)/i,
  /^\.gitconfig(?:[.\s:]|$)/i,
  /^gitconfig(?:[.\s:]|$)/i,
  // PowerShell profiles execute at shell start.
  /^microsoft\.powershell_profile\.ps1(?:[.\s:]|$)/i,
  // Terraform variable files conventionally carry real credentials.
  /^.+\.tfvars(?:[.\s:]|$)/i,
  /^.+\.tfvars\.json(?:[.\s:]|$)/i,
];

export type SafetyResult = { ok: true } | { ok: false; reason: string };

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * Build a normalized *comparison surface* — never used as a real path:
 *  - back-slashes -> forward-slashes
 *  - strip Windows drive prefix (e.g. `C:`)
 *  - strip UNC prefix `//?/`
 *  - strip NTFS alternate-data-stream suffix (`name:stream` / `name::$DATA`)
 *    from each path segment — Windows reads `foo:stream` as `foo` for our
 *    purposes, so the comparison surface should too
 *  - strip trailing dots/spaces from each segment — Windows discards these
 *    at open time, so `.env.` and `.env ` open `.env`
 *  - collapse duplicate slashes
 *  - lowercase (so case variants match on case-insensitive filesystems)
 *  - drop trailing slash (except for root)
 */
function comparisonForm(p: string): string {
  let s = p.replace(/\\/g, "/");
  // UNC / extended-length prefix: \\?\C:\... or //?/C:/... → strip up to drive.
  s = s.replace(/^\/\/\?\//, "/");
  // Drive prefix: C:/foo → /foo. Important: do this BEFORE lowercasing so we
  // don't have to special-case "c:" vs "C:".
  s = s.replace(/^[a-zA-Z]:/, "");
  // Strip NTFS alternate-data-stream syntax from each segment. `name:stream`
  // and `name::$DATA` both read the same underlying file from `name`, so
  // they must compare-equal to `name`.
  s = s
    .split("/")
    .map((seg) => {
      const colon = seg.indexOf(":");
      return colon === -1 ? seg : seg.slice(0, colon);
    })
    .join("/");
  // Strip trailing dots/spaces from each segment (Windows behavior).
  s = s
    .split("/")
    .map((seg) => seg.replace(/[.\s]+$/, ""))
    .join("/");
  // Collapse duplicate slashes (//foo → /foo). Preserve a possible leading
  // single slash.
  s = s.replace(/\/{2,}/g, "/");
  s = s.toLowerCase();
  // Drop trailing slash so "/foo/" and "/foo" compare equal.
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

function isUnderProtected(cmp: string, dir: string): boolean {
  // Protected dirs (`/.ssh`, `/.config/gh`, …) live under the user's home or
  // somewhere else in the tree — they are NOT root-anchored. Match the dir as
  // a path-segment substring: append `/` to both sides so we don't match
  // false positives like `/.sshx` against `/.ssh`.
  //
  //   "/users/me/.ssh/config" + "/" → contains "/.ssh/" ✓
  //   "/users/me/.ssh"        + "/" → contains "/.ssh/" ✓
  //   "/users/me/.sshx/file"  + "/" → does not contain "/.ssh/" ✓
  return (cmp + "/").includes(dir + "/");
}

function describeProtected(dir: string): string {
  // "/.ssh" -> ".ssh", "/.config/gh" -> ".config/gh"
  return dir.replace(/^\//, "");
}

export function checkReadable(path: string): SafetyResult {
  if (typeof path !== "string" || path.length === 0) {
    return { ok: false, reason: "Refused: empty path." };
  }
  // Reject NUL and control bytes in paths — these are never legitimate and
  // are a classic truncation/injection vector.
  if (/[\x00-\x1f]/.test(path)) {
    return { ok: false, reason: "Refused: path contains control bytes." };
  }

  const base = basename(path);
  for (const re of SECRET_BASENAME_PATTERNS) {
    if (re.test(base)) {
      return {
        ok: false,
        reason: `Refused: "${base}" matches a sensitive-file pattern.`,
      };
    }
  }

  const cmp = comparisonForm(path);
  for (const dir of PROTECTED_DIRS) {
    if (isUnderProtected(cmp, dir)) {
      return {
        ok: false,
        reason: `Refused: path is inside a protected directory (${describeProtected(dir)}).`,
      };
    }
  }

  return { ok: true };
}

export function checkWritable(path: string): SafetyResult {
  // Writes inherit all read restrictions, plus system-directory blocks.
  const r = checkReadable(path);
  if (!r.ok) return r;

  const base = basename(path);
  for (const re of WRITE_DENY_BASENAMES) {
    if (re.test(base)) {
      return {
        ok: false,
        reason: `Refused: "${base}" is a shell-init / credential-bearing file. Edit it manually if you really mean it.`,
      };
    }
  }

  const cmp = comparisonForm(path);
  // Ensure the comparison surface has a leading separator for prefix matching.
  const cmpForPrefix = cmp.startsWith("/") ? cmp : `/${cmp}`;
  for (const prefix of WRITE_DENY_PREFIXES) {
    if (cmpForPrefix.startsWith(prefix) || `${cmpForPrefix}/`.startsWith(prefix)) {
      return {
        ok: false,
        reason: `Refused: writes under "${prefix.replace(/\/$/, "")}" are not allowed.`,
      };
    }
  }
  return { ok: true };
}

/**
 * Lightweight heuristic for blocking obviously destructive shell commands
 * even after the user has approved them. The approval UI shows the command
 * verbatim, so the user is the primary gate; this just catches a couple of
 * patterns that almost certainly indicate the model went off the rails.
 */
/**
 * Two-phase safety check that also defends against symlink traversal: first
 * checks the literal path, then (if it exists) canonicalizes it via the
 * native FS and re-checks the resolved path. A symlink at `./innocent.txt`
 * pointing into `~/.ssh/id_rsa` is caught on the second pass.
 *
 * Returns the canonical path on success so callers can use it for the actual
 * read — avoids TOCTOU between the safety check and the read.
 */
/** Record a security/sandbox denial to the audit trail. Fire-and-forget;
 *  the deny path must stay fast and never throw into the tool result. */
function auditDeny(op: "read" | "write", path: string, reason: string): void {
  try {
    auditAppend(
      AUDIT_KINDS.securityDeny,
      op,
      `${reason} — ${path.slice(0, 160)}`,
      "",
    );
  } catch {
    // never break the deny path
  }
}

export async function checkReadableCanonical(
  path: string,
  canonicalize: (p: string) => Promise<string>,
): Promise<{ ok: true; canonical: string } | { ok: false; reason: string }> {
  const initial = checkReadable(path);
  if (!initial.ok) {
    auditDeny("read", path, initial.reason);
    return initial;
  }
  let canonical: string;
  try {
    canonical = await canonicalize(path);
  } catch {
    // Path doesn't exist yet — fine for the read tool to surface ENOENT.
    return { ok: true, canonical: path };
  }
  // Always recheck — even when canonicalize returns the same string, the
  // checks themselves can have OS-specific gaps (NTFS streams, trailing
  // dot/space) that warrant a second pass against the comparison form.
  const recheck = checkReadable(canonical);
  if (!recheck.ok) {
    auditDeny("read", canonical, recheck.reason);
    return recheck;
  }
  // Project sandbox (see lib/sandbox.ts): workspaceOnly confines reads to
  // the project root. No-op when the sandbox is off.
  const sandbox = await checkSandbox("read", canonical);
  if (!sandbox.ok) {
    auditDeny("read", canonical, sandbox.reason);
    return sandbox;
  }
  return { ok: true, canonical };
}

/**
 * Same pattern as {@link checkReadableCanonical} but for writes. The canonical
 * path is only available if the file already exists — for new-file creates
 * we additionally canonicalize the parent directory.
 */
export async function checkWritableCanonical(
  path: string,
  canonicalize: (p: string) => Promise<string>,
): Promise<{ ok: true; canonical: string } | { ok: false; reason: string }> {
  const initial = checkWritable(path);
  if (!initial.ok) {
    auditDeny("write", path, initial.reason);
    return initial;
  }
  // Try canonicalizing the target itself first.
  try {
    const canonical = await canonicalize(path);
    // Always recheck the canonical form — same rationale as checkReadableCanonical.
    const recheck = checkWritable(canonical);
    if (!recheck.ok) {
      auditDeny("write", canonical, recheck.reason);
      return recheck;
    }
    // Project sandbox: readOnly + workspaceBoth confine writes to the
    // project root. No-op when the sandbox is off.
    const sandbox = await checkSandbox("write", canonical);
    if (!sandbox.ok) {
      auditDeny("write", canonical, sandbox.reason);
      return sandbox;
    }
    return { ok: true, canonical };
  } catch {
    // Target doesn't exist — canonicalize the parent so we still catch a
    // symlinked parent directory (`./project -> /Users/me/.ssh`).
    const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    if (lastSep > 0) {
      const parent = path.slice(0, lastSep);
      const tail = path.slice(lastSep);
      try {
        const canonParent = await canonicalize(parent);
        const recheckParent = checkWritable(canonParent + tail);
        if (!recheckParent.ok) {
          auditDeny("write", canonParent + tail, recheckParent.reason);
          return recheckParent;
        }
        const sandbox = await checkSandbox("write", canonParent + tail);
        if (!sandbox.ok) {
          auditDeny("write", canonParent + tail, sandbox.reason);
          return sandbox;
        }
        return { ok: true, canonical: canonParent + tail };
      } catch {
        // Parent doesn't exist either — let the caller surface the actual error.
      }
    }
    return { ok: true, canonical: path };
  }
}

export function checkShellCommand(cmd: string): SafetyResult {
  const c = cmd.trim();
  if (c.length === 0) {
    return { ok: false, reason: "Refused: empty command." };
  }
  // Block NUL bytes in commands — never legitimate.
  if (/\x00/.test(c)) {
    return { ok: false, reason: "Refused: command contains NUL byte." };
  }
  // Block Unicode bidi-override and invisible directional marks. These let an
  // attacker craft a command whose visual order (in the approval UI's <pre>
  // block) differs from its logical execution order — a Trojan Source attack.
  // Legitimate shell commands do not need RTL overrides.
  if (/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/.test(c)) {
    return {
      ok: false,
      reason: "Refused: command contains Unicode bidirectional override characters.",
    };
  }
  // rm -rf / (and variants with quoted /, --no-preserve-root, etc.)
  if (
    /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|--recursive\s+--force|--force\s+--recursive)\s+(['"]?\/['"]?\s*($|;|&|\|))/.test(
      c,
    )
  ) {
    return {
      ok: false,
      reason:
        "Refused: command attempts to recursively delete the filesystem root.",
    };
  }
  // rm -rf ~ / $HOME — wiping the user's home dir
  if (
    /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+(['"]?(~|\$HOME)['"]?)(\s|$|;|&|\|)/.test(
      c,
    )
  ) {
    return {
      ok: false,
      reason: "Refused: command attempts to recursively delete the home directory.",
    };
  }
  if (/--no-preserve-root/.test(c)) {
    return { ok: false, reason: "Refused: --no-preserve-root is not allowed." };
  }
  // dd to a raw disk device
  if (/\bdd\b[^|]*\bof=\/dev\/(disk|sd|nvme|hd)/i.test(c)) {
    return { ok: false, reason: "Refused: dd to a block device is not allowed." };
  }
  // mkfs / fdisk / diskutil eraseDisk / parted
  if (
    /\b(mkfs(\.[a-z0-9]+)?|fdisk|parted)\b/.test(c) ||
    /\bdiskutil\s+erase/i.test(c)
  ) {
    return {
      ok: false,
      reason: "Refused: disk-formatting commands are not allowed.",
    };
  }
  // Fork bomb
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/.test(c)) {
    return { ok: false, reason: "Refused: fork-bomb pattern detected." };
  }
  // Pipe-to-shell from network. The user already approves the command, but
  // this combo is overwhelmingly malicious-payload-shaped and worth flagging.
  if (/\b(curl|wget)\b[^|;&]*\|\s*(ba|z|k|d|fi|c)?sh\b/.test(c)) {
    return {
      ok: false,
      reason:
        "Refused: piping a network download directly into a shell is blocked. Download first, inspect, then run.",
    };
  }
  // LAN-only network policy (Settings → Security): block shell egress to the
  // public internet. One classifier, every execution path — bash_run,
  // bash_background, watch_create, and the approval-allowlist re-check all
  // route through checkShellCommand, so this is the single choke point.
  if (isLanOnlyPolicyActive() && !lanOnlyShellCommandOk(c)) {
    return { ok: false, reason: lanOnlyDenyReason(c) };
  }
  return { ok: true };
}

// ── LAN-only shell egress classifier ───────────────────────────────────────────
//
// DESIGN: best-effort POLICY layer, not a sandbox. It recognizes common
// egress clients and inspects every URL/host literal in the command.
// "Every host is local" (RFC1918/loopback/.local/unqualified) → allowed;
// any public host → denied with the policy pointer. A determined adversary
// could write an unrecognized client, but the layer below (Sandbox
// workspaceOnly) is the OS-confinement backstop — this layer makes
// accidental egress loud instead of silent.

function isLanOnlyPolicyActive(): boolean {
  try {
    const hook = (globalThis as { __kaiLanOnlyPolicy?: () => boolean })
      .__kaiLanOnlyPolicy;
    return hook ? hook() : false;
  } catch {
    return false;
  }
}

/** Hosts that are unambiguously local. */
function isLocalHostLiteral(h: string): boolean {
  const s = h.toLowerCase().replace(/^[[]|[]]$/g, "");
  if (s === "localhost" || s.endsWith(".local") || s.endsWith(".internal")) return true;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(s)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(s)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(s)) return true;
  if (/^(::1|fe80:|fc|fd)/.test(s)) return true;
  if (/^::ffff:/.test(s)) return isLocalHostLiteral(s.slice(7));
  // Unqualified single-label hostname (nas, printer): resolvable only via
  // LAN search domains in practice — treat as local.
  return !s.includes(".") && s.length > 0;
}

/** Host-carrying tokens in the command: URLs and scp-style user@host:path. */
function extractHostsFromCommand(c: string): string[] {
  const hosts: string[] = [];
  const urlRe = /[a-z][a-z0-9+.-]*:\/\/(?:[^@\s]+@)?(\[[^\]]+\]|[a-z0-9._-]+)(?::\d+)?/gi;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(c)) !== null) hosts.push(m[1] ?? "");
  const scpRe = /\b[a-z0-9._%+-]+@([a-z0-9._-]+):/gi;
  while ((m = scpRe.exec(c)) !== null) hosts.push(m[1] ?? "");
  return hosts.filter(Boolean);
}

/** Commands that can reach the network. */
const EGRESS_RE =
  /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|nc|ncat|netcat|socat|ssh|scp|sftp|rsync|telnet|ftp|git\s+(clone|fetch|pull|push|remote|ls-remote|submodule)|npm|pnpm|yarn|bun|pip|pip3|uv\s+pip|cargo\s+(install|update|publish)|go\s+(get|install|mod)|gem|composer|dotnet\s+(add|restore|install)|brew|apt|apt-get|dnf|yum|winget|choco|scoop)\b/i;

/** Package installs: allowed ONLY when a local registry/index is pinned. */
function hasLocalRegistryFlag(c: string): boolean {
  return (
    /--registry(\s|=)\S+/i.test(c) ||
    /--index-url(\s|=)\S+/i.test(c) ||
    /--extra-index-url(\s|=)\S+/i.test(c) ||
    /GOPROXY=\s*"?(direct|off)/i.test(c)
  );
}

/** Is this command acceptable under the LAN-only policy? */
function lanOnlyShellCommandOk(c: string): boolean {
  if (!EGRESS_RE.test(c)) return true; // not network-shaped → allow
  const lower = c.toLowerCase();
  if (
    /\b(npm|pnpm|yarn|bun)\b/.test(lower) &&
    /\b(add|install|i|ci|update|upgrade|dlx|exec|create)\b/.test(lower)
  ) {
    return hasLocalRegistryFlag(c);
  }
  if (/\b(pip|pip3|uv)\b/.test(lower) && /install|download/i.test(lower)) {
    return hasLocalRegistryFlag(c);
  }
  if (/\bcargo\b/.test(lower) && /\b(install|update|publish)\b/.test(lower)) {
    return hasLocalRegistryFlag(c);
  }
  // Everything else: every host literal in the command must be local.
  const hosts = extractHostsFromCommand(c);
  if (hosts.length === 0) {
    // Egress client with no visible host — indistinguishable from policy
    // evasion (config-file URL, alias) → deny.
    return false;
  }
  return hosts.every(isLocalHostLiteral);
}

function lanOnlyDenyReason(c: string): string {
  const hosts = extractHostsFromCommand(c);
  const publicHost = hosts.find((h) => !isLocalHostLiteral(h));
  if (publicHost) {
    return `Refused: "LAN only" network policy is active (Settings → Security) and this command reaches the public internet (${publicHost}). Turn the policy off, or point it at a LAN address.`;
  }
  return 'Refused: "LAN only" network policy is active (Settings → Security) and this command can reach the internet (public registry or hidden host). Use a LAN/local registry or turn the policy off.';
}
