#!/usr/bin/env node
/**
 * EOL hygiene — check and repair the working tree's line endings.
 *
 * The repo's contract (.gitattributes: `* text=auto eol=lf`) is that every
 * text file's WORKING TREE copy is LF. When it silently becomes CRLF the
 * damage is invisible to git — `git add` normalizes, `git status` shows
 * nothing — but the in-app AI edit tools match `old_string` byte-exactly,
 * so multi-line anchors start failing with "not found" on text the file
 * clearly contains. Every documented case came from one source: PowerShell
 * line surgery ([IO.File]::WriteAllLines / Set-Content / Out-File all write
 * CRLF on Windows).
 *
 * Modes:
 *   node scripts/eol.mjs            check: list every violation, exit 1 if any
 *   node scripts/eol.mjs --fix      fix:   renormalize violations via git
 *
 * What counts as a violation:
 *   1. `git ls-files --eol` reporting w/crlf or w/mixed for a file git treats
 *      as text (i/- side shows lf/crlf/mixed = normalized in the index; "-" =
 *      binary via .gitattributes — those are exempt). Covers tracked files.
 *   2. UNTRACKED text files containing a \r\n — git's --eol listing never
 *      shows them, but a later `git add` would stage them normalized while
 *      the working copy stays CRLF, priming the next anchor failure.
 *
 * The fix uses the SAFE three-step recipe (verified against git 2.55):
 *   1. `git add <file>`      — the index receives the LF-normalized copy.
 *      (Nothing can be lost: git reports w/crlf only when the working copy
 *      differs from the index BY EOL ALONE, so the staged copy IS your
 *      content. Skip this step and step 3 silently restores the last
 *      COMMITTED content instead — the destructive mistake that cost a
 *      full extraction session once.)
 *   2. DELETE the working file (plain fs unlink — NOT `git rm`, which would
 *      also purge the just-staged index entry when the file is new).
 *   3. `git checkout-index -f -- <file>` — rewrites it from the index (LF,
 *      because .gitattributes says eol=lf).
 * Steps 2+3 are REQUIRED together: `git checkout -- <file>` and
 * `checkout-index` are both silent no-ops while the working file still
 * exists, because git compares content and sees "no diff" — the EOL-only
 * difference is invisible to it. Deleting the file first forces the
 * rewrite.
 *
 * After a fix run the index holds the LF copies (they are STAGED — commit
 * them with the rest of your work) and `node scripts/eol.mjs` must print
 * "working tree is clean".
 */
import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { extname } from "node:path";

const FIX = process.argv.includes("--fix");

const run = (args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** .gitattributes-declared binary or CRLF-intended extensions never count. */
const SKIP_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".icns", ".webp", ".bmp", ".tiff",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".wav", ".ogg", ".flac", ".mov", ".webm",
  ".zip", ".gz", ".tgz", ".tar", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".a", ".lib", ".wasm", ".node", ".pdf", ".jar",
  // cmd.exe misparses LF-only batch files — these are eol=crlf on purpose.
  ".bat", ".cmd",
]);

const violations = [];

// ── 1. Tracked files: parse git's own --eol report ────────────────────────
// Format: "i/<ieol>  w/<weol>  attr/<attrs>  <path>"
const eolOut = run(["ls-files", "--eol"]);
for (const line of eolOut.split("\n")) {
  const m = /^i\/(\S+)\s+w\/(\S+)\s+attr\/\S+?\s+(.*)$/.exec(line);
  if (!m) continue;
  const [, ieol, weol, path] = m;
  if (weol !== "crlf" && weol !== "mixed") continue;
  // Binary files have ieol "-" (no text conversion) — not our contract.
  if (ieol === "-") continue;
  const ext = extname(path).toLowerCase();
  if (SKIP_EXT.has(ext)) continue;
  violations.push({ path, weol, tracked: true });
}

// ── 2. Untracked text files with CRLF bytes ───────────────────────────────
const untrackedFiles = run(["ls-files", "--others", "--exclude-standard", "-z"])
  .split("\0")
  .filter(Boolean);

for (const rel of untrackedFiles) {
  const ext = extname(rel).toLowerCase();
  if (SKIP_EXT.has(ext)) continue;
  let buf;
  try {
    buf = readFileSync(rel);
  } catch {
    continue; // unreadable (locked, permissions) — not an EOL verdict
  }
  if (buf.includes(0)) continue; // NUL byte → binary
  if (buf.toString("utf8").includes("\r\n")) {
    violations.push({ path: rel, weol: "crlf", tracked: false });
  }
}

// ── Report + fix ──────────────────────────────────────────────────────────
if (violations.length === 0) {
  console.log("eol: working tree is clean (all text files are LF).");
  process.exit(0);
}

for (const v of violations) {
  console.log(`eol: ${v.weol}  ${v.path}  ${v.tracked ? "(tracked)" : "(untracked)"}`);
}

if (!FIX) {
  console.error(
    `\neol: ${violations.length} file(s) have CRLF/mixed line endings. ` +
      `git status shows nothing (add normalizes), so byte-exact edit anchors ` +
      `will fail on these files. Run \`node scripts/eol.mjs --fix\` to repair.`,
  );
  process.exit(1);
}

let fixed = 0;
for (const v of violations) {
  try {
    // 1. Stage first: the index gets the LF copy of YOUR content. Skipping
    //    this makes step 3 restore the last committed content (data loss).
    run(["add", "--", v.path]);
    // 2. Plain fs delete — NOT `git rm` (it would purge the staged index
    //    entry for a NEW file, leaving nothing to check out).
    unlinkSync(v.path);
    // 3. Rewrite from the index (LF via eol=lf). The delete is REQUIRED:
    //    with the file present git sees "no content diff" and skips the
    //    write, keeping the CRLF bytes.
    run(["checkout-index", "-f", "--", v.path]);
    fixed++;
  } catch (e) {
    console.error(`eol: failed to fix ${v.path}: ${e.message}`);
  }
}
console.log(`eol: renormalized ${fixed}/${violations.length} file(s).`);
console.log(
  fixed === violations.length
    ? "eol: all files repaired (LF copies are STAGED — commit them with the rest of your work)."
    : "eol: some files could not be repaired — see errors above.",
);
process.exit(fixed === violations.length ? 0 : 1);

