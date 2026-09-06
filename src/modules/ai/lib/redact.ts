/**
 * Secret redaction for text leaving the app toward a model provider.
 *
 * Two tiers, because the cost of a false positive is not uniform:
 *
 *  - **Value-shaped** patterns (`AKIA…`, `sk-ant-…`, `-----BEGIN PRIVATE KEY-----`)
 *    are high-entropy and essentially never appear as placeholders in real
 *    source. Safe to strip from *everything*.
 *  - **Name-shaped** patterns (`API_KEY=<anything>`) are a guess. They fire on
 *    `.env.example`, config scaffolding, docs, and test fixtures. Redacting
 *    them from file contents would break the read→edit loop — an `old_string`
 *    copied out of a redacted `read_file` never matches the real file — so they
 *    are applied only to free-text output (shell stdout, web pages, search
 *    dumps) where the model is not going to quote the text back as an edit.
 *
 * Every pattern carries `probe` literals: running twelve global regexes over a
 * 256 KB tool output on every token is how the streaming-render freeze
 * happened once already (see project memory — `stripLeakedTokens`). The probe
 * is a cheap `indexOf` gate in front of each regex.
 */

type RedactMode = "source" | "payload";

type Pattern = {
  kind: string;
  /** Any-of literal gate. The regex only runs if one of these is present. */
  probe: string[];
  re: RegExp;
  tier: RedactMode;
  /** Rebuilds the match. Defaults to `<REDACTED:kind>`. */
  replacer?: (m: string, ...groups: string[]) => string;
};

const PATTERNS: Pattern[] = [
  {
    kind: "private-key-block",
    probe: ["BEGIN "],
    // Armored key material — the only pattern here that spans lines.
    re: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENHANCED |XE25519 |)PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
    tier: "source",
  },
  {
    // Must run before `openai-key`, and must exclude the `ant-` prefix: an
    // Anthropic key also starts with `sk-` and its remainder is entirely
    // inside `[A-Za-z0-9_-]`, so without the lookahead the OpenAI pattern
    // swallows it and every Anthropic key reports as `openai-key`.
    kind: "anthropic-key",
    probe: ["sk-ant-"],
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    tier: "source",
  },
  {
    kind: "openai-key",
    probe: ["sk-"],
    re: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
    tier: "source",
  },
  {
    kind: "aws-access-key",
    probe: ["AKIA", "ASIA"],
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    tier: "source",
  },
  {
    kind: "github-token",
    probe: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"],
    re: /\bgh[opsur]_[A-Za-z0-9]{36,}\b/g,
    tier: "source",
  },
  {
    kind: "github-pat",
    probe: ["github_pat_"],
    re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
    tier: "source",
  },
  {
    kind: "google-api-key",
    probe: ["AIza"],
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    tier: "source",
  },
  {
    kind: "slack-token",
    probe: ["xox"],
    re: /\bxox[bpsare]-[A-Za-z0-9-]{10,}\b/g,
    tier: "source",
  },
  {
    kind: "stripe-key",
    probe: ["_live_", "_test_"],
    re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b/g,
    tier: "source",
  },
  {
    kind: "jwt",
    probe: ["eyJ"],
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    tier: "source",
  },
  {
    kind: "bearer",
    probe: ["Bearer ", "bearer "],
    re: /\b[Bb]earer\s+[A-Za-z0-9._-]{20,}/g,
    tier: "source",
  },
  {
    // Name-based heuristic — payload tier only. See the header comment.
    // Preserves the original name + separator (`:` or `=`); drops the value.
    // The value class excludes `<`/`>` so an already-redacted
    // `FOO=<REDACTED:openai-key>` is not re-matched — terminal scrollback is
    // redacted once by App.tsx and again by the tool layer, and that has to be
    // a no-op rather than a nested rewrite.
    kind: "env-assign",
    probe: [
      "KEY", "key", "SECRET", "secret", "TOKEN", "token",
      "PASSWORD", "password", "PASSWD", "passwd",
    ],
    // Matches ANY `identifier := value` and decides in the replacer whether the
    // name looks secret. Two reasons not to bake the name list into the regex:
    //   1. An alternation has to enumerate every name — GITHUB_TOKEN,
    //      NPM_TOKEN, GITLAB_TOKEN… — and the list is unbounded. (A test for
    //      GITHUB_TOKEN is exactly what caught this.)
    //   2. A long alternation of nested character classes invites backtracking.
    // The identifier shape here is a single chain of alnum runs separated by one
    // `_`/`-`, so each repetition consumes a mandatory separator — no
    // `(a*a*)*` blowup.
    re: /\b([A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)*)\s*([:=])\s*("?)[^\s"';|&<>]+\3/g,
    tier: "payload",
    replacer: (m, name, _sep, quote) =>
      SECRET_NAME_RE.test(name)
        ? `${name}=<REDACTED:${quote ? "quoted" : "bare"}>`
        : m,
  },
];

/**
 * Name test for the `env-assign` heuristic. Case-insensitive.
 *
 * Requires an actual credential word rather than any identifier, so ordinary
 * config (`PORT=3000`, `NODE_ENV=production`, `HOST=localhost`) survives.
 */
const SECRET_NAME_RE = /(?:^|[_-])(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|CERT|AUTH|SIGNING|ACCESS|PRIVATE)(?:[_-]|$)/i;

function hasAny(haystack: string, needles: string[]): boolean {
  for (const n of needles) {
    if (haystack.indexOf(n) !== -1) return true;
  }
  return false;
}

function applyPatterns(text: string, tier: RedactMode): string {
  let out = text;
  for (const p of PATTERNS) {
    if (tier === "source" && p.tier !== "source") continue;
    if (!hasAny(out, p.probe)) continue;
    // Clone per use: `lastIndex` on a shared /g regex leaks between calls if
    // a replace is ever interrupted.
    const re = new RegExp(p.re.source, p.re.flags);
    out = p.replacer
      ? out.replace(re, (m, ...rest) => p.replacer!(m, ...(rest as string[])))
      : out.replace(re, `<REDACTED:${p.kind}>`);
  }
  return out;
}

/** Full redaction, including name-based `KEY=value`. Terminal scrollback. */
export function redactSensitive(text: string): string {
  return applyPatterns(text, "payload");
}

/** Value-shaped secrets only. Safe on file contents / edit round-trips. */
export function redactSourceText(text: string): string {
  return applyPatterns(text, "source");
}

// ── Tool-result walking ──────────────────────────────────────────────────

/**
 * Keys whose values must survive verbatim.
 *
 * Redacting a `path` would emit a tool result the model cannot act on — it
 * would try to read or edit the literal string `<REDACTED:…>`, turning a leak
 * prevention into a broken tool. Paths are not secrets; they are addresses.
 * `base64_data` is image/video payload: megabytes of near-random text that no
 * secret pattern meaningfully matches, and regexing it would stall the run.
 */
const VERBATIM_KEYS: ReadonlySet<string> = new Set([
  "path",
  "rel",
  "root",
  "base64_data",
]);

/** Per-string scan cap. Beyond this, output is almost certainly binary/media
 *  payload rather than prose, and the regex cost is not worth it. */
const MAX_SCAN_LEN = 1_000_000;

const MAX_DEPTH = 12;

/**
 * Redact every string *value* in a tool result, preserving structure.
 *
 * Returns the original reference when nothing needed changing, so the common
 * case (a clean result) costs one walk and no reallocation.
 *
 * Object *keys* are never rewritten — in this codebase some records key files
 * by path, and a rewritten key would silently orphan the entry.
 */
export function redactToolResult<T>(value: T, mode: RedactMode = "source"): T {
  return redactInner(value, mode, 0, new WeakSet()) as T;
}

function redactInner(
  value: unknown,
  mode: RedactMode,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") {
    if (value.length === 0 || value.length > MAX_SCAN_LEN) return value;
    return applyPatterns(value, mode);
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return value;
  if (seen.has(value)) return value; // cycle guard
  seen.add(value);

  if (Array.isArray(value)) {
    let touched = false;
    const out = new Array<unknown>(value.length);
    for (let i = 0; i < value.length; i++) {
      const next = redactInner(value[i], mode, depth + 1, seen);
      if (next !== value[i]) touched = true;
      out[i] = next;
    }
    return touched ? out : value;
  }

  let touched = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    let next: unknown;
    if (VERBATIM_KEYS.has(k) || typeof v !== "string") {
      next = VERBATIM_KEYS.has(k) ? v : redactInner(v, mode, depth + 1, seen);
    } else {
      next = v.length === 0 || v.length > MAX_SCAN_LEN
        ? v
        : applyPatterns(v, mode);
    }
    if (next !== v) touched = true;
    out[k] = next;
  }
  return touched ? out : value;
}

/**
 * Tools whose result is free text the model will never quote back as an
 * `old_string`. These get the payload tier, which additionally strips
 * name-based `KEY=value` assignments.
 */
const PAYLOAD_TOOLS: ReadonlySet<string> = new Set([
  "bash_run",
  "shell_session_run",
  "bash_logs",
  "get_terminal_output",
  "web_browse",
  "web_fetch",
  "web_search",
  "youtube_transcript",
  "run_subagent",
]);

export function redactToolOutput<T>(toolName: string, value: T): T {
  return redactToolResult(value, PAYLOAD_TOOLS.has(toolName) ? "payload" : "source");
}
