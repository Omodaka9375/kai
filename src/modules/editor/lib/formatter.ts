/**
 * Editor text formatting (right-click → "Format Document"/"Format Selection").
 *
 * Web languages (json/markdown/html/css/js/ts/…) run through prettier —
 * in-process, no temp files. Python shells out to `black` via the one-shot
 * command runner (writing a temp file is required: black only formats files).
 *
 * Everything here is selection-aware: when the editor has a selection we
 * format just that text and restore the selection afterwards. Prettier can't
 * format arbitrary fragments, so a selection is padded into a syntactically
 * valid wrapper when the parser needs it (e.g. HTML/css fragments).
 */

import type { Plugin } from "prettier";
import { native } from "@/modules/ai/lib/native";

/**
 * Load every plugin the parser needs, in TWO layers:
 *
 *  1. the parser's own plugin (the thing that can parse this file at all), and
 *  2. the plugins for any languages EMBEDDED in it — prettier delegates
 *     `<script>` / `<style>` / fenced code blocks to those parsers, and a
 *     missing one is not an error, it silently leaves the block untouched.
 *
 * Layer 1 is load-bearing: `prettier/standalone` resolves parsers ONLY from
 * the plugins passed here, so `parser: "json"` without the babel plugin
 * throws "Couldn't resolve parser" and the format command does nothing.
 *
 * All imports are dynamic so unused formatters stay out of the editor chunk.
 */
async function loadPrettierPlugins(parsers: string[]): Promise<Plugin[]> {
  const plugins: Plugin[] = [];
  const need = new Set(parsers);

  /** Script/style blocks inside these are delegated to other parsers. */
  const embedsCode =
    need.has("html") ||
    need.has("vue") ||
    need.has("angular") ||
    need.has("lwc") ||
    need.has("mjml") ||
    need.has("markdown") ||
    need.has("mdx");

  // JS family, plus the ``json`` parsers (they live in the babel plugin and
  // print through the estree printer), plus every embedded-code host.
  if (
    embedsCode ||
    need.has("babel") ||
    need.has("babel-ts") ||
    need.has("typescript") ||
    need.has("flow") ||
    need.has("espree") ||
    need.has("acorn") ||
    need.has("meriyah") ||
    need.has("json") ||
    need.has("jsonc") ||
    need.has("json5")
  ) {
    plugins.push((await import("prettier/plugins/babel")) as unknown as Plugin);
    plugins.push((await import("prettier/plugins/estree")) as unknown as Plugin);
  }
  // TypeScript parser is separate from babel's ``babel-ts``. Embedded hosts
  // load it too: a ``<script lang="ts">`` block (or a ```ts fence) is only
  // formatted when its parser is present, otherwise it is left verbatim.
  if (need.has("typescript") || embedsCode) {
    plugins.push((await import("prettier/plugins/typescript")) as unknown as Plugin);
  }
  if (need.has("flow")) {
    plugins.push((await import("prettier/plugins/flow")) as unknown as Plugin);
  }
  if (need.has("acorn") || need.has("espree")) {
    plugins.push((await import("prettier/plugins/acorn")) as unknown as Plugin);
  }
  if (need.has("meriyah")) {
    plugins.push((await import("prettier/plugins/meriyah")) as unknown as Plugin);
  }
  if (
    need.has("html") ||
    need.has("vue") ||
    need.has("angular") ||
    need.has("lwc") ||
    need.has("mjml")
  ) {
    plugins.push((await import("prettier/plugins/html")) as unknown as Plugin);
  }
  // style= blocks in html/vue need postcss, so embedsCode pulls it too.
  if (
    embedsCode ||
    need.has("css") ||
    need.has("scss") ||
    need.has("less") ||
    need.has("postcss")
  ) {
    plugins.push((await import("prettier/plugins/postcss")) as unknown as Plugin);
  }
  if (need.has("markdown") || need.has("mdx")) {
    plugins.push((await import("prettier/plugins/markdown")) as unknown as Plugin);
  }
  if (need.has("yaml")) {
    plugins.push((await import("prettier/plugins/yaml")) as unknown as Plugin);
  }
  if (need.has("graphql")) {
    plugins.push((await import("prettier/plugins/graphql")) as unknown as Plugin);
  }
  return plugins;
}

export type FormattableLanguage =
  | "javascript"
  | "typescript"
  | "json"
  | "json5"
  | "html"
  | "vue"
  | "css"
  | "scss"
  | "less"
  | "markdown"
  | "mdx"
  | "yaml"
  | "graphql"
  | "python";

type PrettierSpec = {
  kind: "prettier";
  /** Parser(s) — first is primary, rest are plugin deps (e.g. estree). */
  parsers: string[];
  /** Indentation-aware defaults. */
  options?: Record<string, unknown>;
};

type ExternalSpec = {
  kind: "external";
  /** CLI label for the UI ("Format Document (black)"). */
  label: string;
};

type FormatSpec = PrettierSpec | ExternalSpec;

/** Extension registry — mirrors languageResolver.ts coverage for the
 *  formattable subset. Keep the two files in sync when adding languages. */
const EXTENSION_MAP: Record<string, FormatSpec> = {
  // JavaScript / TypeScript
  js: prettier(["babel", "estree"]),
  mjs: prettier(["babel", "estree"]),
  cjs: prettier(["babel", "estree"]),
  jsx: prettier(["babel", "estree"], { jsxSingleQuote: false }),
  ts: prettier(["typescript", "estree"]),
  tsx: prettier(["typescript", "estree"]),
  // JSON family
  json: prettier(["json"]),
  jsonc: prettier(["jsonc"]),
  json5: prettier(["json5"]),
  // Web — vue gets its own parser: parsed as plain HTML the <script> body is
  // left untouched (no JS formatting at all).
  html: prettier(["html"]),
  htm: prettier(["html"]),
  vue: prettier(["vue"]),
  css: prettier(["css"]),
  scss: prettier(["scss"]),
  less: prettier(["less"]),
  // Markdown
  md: prettier(["markdown"], { proseWrap: "preserve" }),
  markdown: prettier(["markdown"], { proseWrap: "preserve" }),
  mdx: prettier(["mdx"]),
  // Config / data
  yml: prettier(["yaml"]),
  yaml: prettier(["yaml"]),
  graphql: prettier(["graphql"]),
  gql: prettier(["graphql"]),
  // Python
  py: {
    kind: "external",
    label: "black",
  },
};

function prettier(parsers: string[], options?: Record<string, unknown>): PrettierSpec {
  return { kind: "prettier", parsers, options };
}

function quote(s: string): string {
  return /[\s"&|<>()^%]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function detectLanguage(path: string): FormattableLanguage | null {
  const ext = extensionOf(path);
  const spec = EXTENSION_MAP[ext];
  if (!spec) return null;
  switch (spec.kind) {
    case "prettier":
      if (spec.parsers[0] === "babel" || spec.parsers[0] === "espree") return "javascript";
      if (spec.parsers[0] === "typescript") return "typescript";
      return spec.parsers[0] as FormattableLanguage;
    case "external":
      return "python";
  }
}

export function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/** Human label for the UI ("Format Document (prettier·json)"). */
export function formatterLabelFor(path: string): string | null {
  const spec = EXTENSION_MAP[extensionOf(path)];
  if (!spec) return null;
  return spec.kind === "prettier" ? "prettier" : spec.label;
}

export function isFormattable(path: string): boolean {
  return extensionOf(path) in EXTENSION_MAP;
}

/** Prettier options passed for every format. */
function baseOptions(): Record<string, unknown> {
  return {
    tabWidth: 2,
    useTabs: false,
    semi: true,
    singleQuote: false,
    printWidth: 80,
  };
}

async function runPrettier(
  source: string,
  parsers: string[],
  options?: Record<string, unknown>,
): Promise<string> {
  const { format } = await import("prettier/standalone");
  const plugins = await loadPrettierPlugins(parsers);
  return format(source, {
    ...baseOptions(),
    ...options,
    parser: parsers[0],
    plugins,
  });
}

/** Format a whole document. Throws with a readable message on failure. */
export async function formatDocument(
  path: string,
  source: string,
): Promise<string> {
  const spec = EXTENSION_MAP[extensionOf(path)];
  if (!spec) throw new Error(`No formatter for this file type.`);
  if (spec.kind === "prettier") {
    try {
      return await runPrettier(source, spec.parsers, spec.options);
    } catch (e) {
      throw new Error(prettierError(e, path));
    }
  }
  return runBlack(source, path);
}

/**
 * Format only the selected text. Returns the formatted fragment, or null
 * when the fragment isn't parseable in isolation (e.g. half an HTML tree,
 * a JSON slice) — the caller then falls back to formatting the whole
 * document so the user still gets a result instead of an error.
 *
 * Prettier's babel/typescript/css/markdown parsers accept many fragment
 * shapes (statement lists, rule blocks, prose) directly; html/json usually
 * don't, and those become whole-doc formats.
 */
export async function formatSelection(
  path: string,
  fragment: string,
): Promise<string | null> {
  const lang = detectLanguage(path);
  if (!lang) return null;
  if (lang === "python") {
    return runBlack(fragment, path);
  }
  const spec = EXTENSION_MAP[extensionOf(path)];
  if (!spec || spec.kind !== "prettier") return null;
  try {
    const formatted = await runPrettier(fragment, spec.parsers, spec.options);
    // Prettier always appends a trailing newline; for a whole document that's
    // desirable, but splicing a selection that gained "\n" at the end would
    // swallow the line after the selection. Trim it for fragments.
    return formatted.replace(/\n$/, "");
  } catch {
    // Fragment not parseable in isolation — signal whole-doc fallback.
    return null;
  }
}

function prettierError(e: unknown, path: string): string {
  const msg = e instanceof Error ? e.message : String(e);
  // Prettier syntax errors look like:
  // "Expecting, ... (line: 1, col: 3)" or "Unexpected token (1:2)".
  return /syntax|unexpected|expecting|invalid/i.test(msg)
    ? `Could not format: the file has a syntax error. Fix it and try again.`
    : `Prettier failed on ${path.split(/[\\/]/).pop()}: ${msg}`;
}

// ── Python via black ─────────────────────────────────────────────────

async function runBlack(source: string, path: string): Promise<string> {
  // black has no usable stdin through shell_run_command, so we round-trip a
  // temp file *in the same directory* as the real file — per-file config
  // discovery (pyproject.toml) then matches what the real file would get.
  const dir = path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
  const inputPath = `${dir}/.kai-format-${Date.now()}.py`;
  await native.writeFile(inputPath, source);
  try {
    const res = await native.runCommand(
      `black ${quote(inputPath)} --quiet`,
      dir || null,
      30,
    );
    if (res.exit_code !== 0 || res.timed_out) {
      throw new Error(
        res.timed_out
          ? "black timed out."
          : `black failed: ${res.stderr.trim() || res.stdout.trim() || `exit ${res.exit_code}`}`,
      );
    }
    const out = await native.readFile(inputPath);
    if (out.kind !== "text") throw new Error("black output unreadable.");
    return out.content;
  } finally {
    await native.deleteFile(inputPath).catch(() => undefined);
  }
}
