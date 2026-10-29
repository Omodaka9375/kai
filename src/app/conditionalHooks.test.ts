import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Conditional hook calls are fatal in KAI specifically: components stay
 * MOUNTED across workspace foreground/background transitions (parallel
 * projects), so `isActive`/`runtime` props flip on every project switch.
 * A skipped hook shifts the hook order on the next render; React's
 * production build doesn't verify hook types at the same slot — it reads a
 * non-effect hook's memoizedState as `deps`, throws `TypeError: Cannot read
 * properties of undefined (reading 'length')` inside areHookInputsEqual, and
 * unmounts the entire tree: the "themed blank window on project switch".
 *
 * This test bans the two textual shapes that caused it:
 *   `cond && useXxx(...)`  and  `expr ?? useXxx(...)`
 */

const SRC_ROOT = new URL("../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const PATTERN = /(&&|\?\?)\s*use[A-Z]\w*\(/;

describe("no conditional hook calls", () => {
  it("never gates a use*() call behind && or ??", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        if (PATTERN.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
