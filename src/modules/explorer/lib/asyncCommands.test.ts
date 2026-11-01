/**
 * Heavy Rust commands must stay `async` (source pins).
 *
 * In Tauri 2 a NON-async `#[tauri::command]` runs on the MAIN thread. The
 * commands below do unbounded IO (whole-tree walks, OCR, toolchain probes)
 * — as sync commands each froze the entire app for the duration of the
 * call ("big long searches freeze the whole app for 4-5 seconds", 2026-11-01).
 * Async commands run on the runtime's worker pool and never touch the UI
 * event loop.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Frontend test files cannot import outside `src/`, so read the Rust sources
// directly (same pattern as the shell tool surface pins).
const rustRoot = join(__dirname, "../../../../src-tauri/src/modules/fs");

const read = (rel: string): string =>
  readFileSync(join(rustRoot, rel), "utf8");

const pins: { file: string; fn: string; why: string }[] = [
  { file: "grep.rs", fn: "fs_grep", why: "walks + regexes every candidate file in the tree" },
  { file: "search.rs", fn: "fs_search", why: "walks the tree to the match cap (or the whole tree on no match)" },
  { file: "extract.rs", fn: "fs_extract_image_bytes", why: "image decode + tesseract OCR can take seconds" },
  { file: "env_probe.rs", fn: "fs_env_inventory", why: "uncached probe shells out for hundreds of ms" },
];

describe("heavy fs commands run off the main thread (source pins)", () => {
  for (const { file, fn, why } of pins) {
    it(`${fn} (${file}) is an async command — ${why}`, () => {
      const src = read(file);
      // The command declaration must be immediately preceded by
      // #[tauri::command] and be `pub async fn` (whitespace- and
      // doc/note-comment-tolerant: rustfmt can reflow attribute placement).
      const decl = new RegExp(
        `#\\[tauri::command\\]\\s*(?://[^\\n]*\\n\\s*)*pub\\s+async\\s+fn\\s+${fn}\\b`,
      );
      expect(src).toMatch(decl);
      expect(src).not.toMatch(
        new RegExp(
          `#\\[tauri::command\\]\\s*(?://[^\\n]*\\n\\s*)*pub\\s+fn\\s+${fn}\\b`,
        ),
      );
    });
  }
});