import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * EOL hygiene drift gate (2026-11-10).
 *
 * Two sessions in a row, PowerShell line surgery ([IO.File]::WriteAllLines)
 * silently CRLF'd working-tree files: git status showed nothing (add
 * normalizes), the byte-exact edit anchors then failed on those files, and
 * the manual `git checkout --` "fix" DESTROYED unstaged work because
 * checkout restores from the index, which held the pre-edit content.
 *
 * This gate runs INSIDE the normal test suite, so a CRLF-corrupted working
 * tree fails `pnpm test` immediately with a named file list instead of
 * surfacing later as mysterious edit-anchor misses. It checks exactly what
 * scripts/eol.mjs checks (git's own --eol report for tracked files), plus
 * the enforcement wiring:
 *   - package.json exposes `eol:check` / `eol:fix`
 *   - .gitattributes still carries the `* text=auto eol=lf` policy
 *
 * If this test fails: run `node scripts/eol.mjs --fix` (safe — it stages
 * first, so your content is preserved; see the script header), then re-run.
 * Do NOT hand-run `git checkout -- <file>` on unstaged files to "fix" EOL.
 */

const run = (args: string[]) =>
  execFileSync("git", args, {
    encoding: "utf8",
    cwd: new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    maxBuffer: 64 * 1024 * 1024,
  });

describe("EOL hygiene — the working tree stays LF (edit anchors depend on it)", () => {
  it("no tracked text file is w/crlf or w/mixed", () => {
    const out = run(["ls-files", "--eol"]);
    const bad: string[] = [];
    // Format: "i/<ieol>  w/<weol>  attr/<attrs><TAB><path>" — attrs contain
    // spaces ("text=auto eol=lf "), the path starts after the TAB.
    let parsedAny = 0;
    for (const line of out.split("\n")) {
      const m = /^i\/(\S*)\s+w\/(\S+)\s+attr\/(.*)\t(.*)$/.exec(line);
      if (!m) continue;
      parsedAny++;
      const [, ieol, weol, , path] = m;
      if (weol !== "crlf" && weol !== "mixed") continue;
      if (ieol === "-") continue; // binary via .gitattributes — exempt
      if (/\.(bat|cmd)$/i.test(path)) continue; // eol=crlf on purpose
      bad.push(path);
    }
    // Guard the parser itself: if the regex stopped matching ANY line, the
    // git output format changed and this gate would silently pass forever.
    expect(
      parsedAny,
      "eol gate regex parsed no ls-files lines — git output format changed?",
    ).toBeGreaterThan(100);
    expect(
      bad,
      `CRLF/mixed working-tree files (git status shows NOTHING — run \`node scripts/eol.mjs --fix\`): ${bad.join(", ")}`,
    ).toEqual([]);
  });

  it("the enforcement wiring exists (scripts + policy)", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts["eol:check"]).toBe("node scripts/eol.mjs");
    expect(pkg.scripts["eol:fix"]).toBe("node scripts/eol.mjs --fix");
    const attrs = readFileSync(new URL("../../.gitattributes", import.meta.url), "utf8");
    expect(attrs).toContain("* text=auto eol=lf");
    expect(attrs).toContain("*.bat  text eol=crlf");
  });

  it("the repair tool itself is wired with the safe stage-first recipe", () => {
    const tool = readFileSync(new URL("../../scripts/eol.mjs", import.meta.url), "utf8");
    // Stage BEFORE deleting: the comment documents WHY the order matters.
    expect(tool.indexOf('run(["add", "--", v.path])')).toBeGreaterThan(-1);
    expect(tool.indexOf('run(["checkout-index", "-f", "--", v.path])')).toBeGreaterThan(
      tool.indexOf('run(["add", "--", v.path])'),
    );
    // `git rm` must NOT appear in the fix loop — it purges the staged entry
    // for new files, leaving nothing to check out (bug found in self-test).
    expect(tool).not.toMatch(/run\(\["rm"/);
  });
});
