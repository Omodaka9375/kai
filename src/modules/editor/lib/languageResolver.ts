import type { Extension } from "@codemirror/state";

type LoaderResult = Extension | { token: unknown };
type LanguageLoader = () => Promise<LoaderResult>;

/**
 * Extension → loader. Each loader is a dynamic import so language packs
 * only enter the bundle when a matching file is opened.
 *
 * Loaders may return either a ready Extension (lang-* packages) or a raw
 * StreamParser (legacy-modes). `resolveLanguage` wraps the latter in
 * StreamLanguage before returning.
 */
const loaders: Record<string, LanguageLoader> = {
  // JavaScript / TypeScript family
  js: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  jsx: () =>
    import("@codemirror/lang-javascript").then((m) =>
      m.javascript({ jsx: true }),
    ),
  mjs: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  cjs: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  ts: () =>
    import("@codemirror/lang-javascript").then((m) =>
      m.javascript({ typescript: true }),
    ),
  tsx: () =>
    import("@codemirror/lang-javascript").then((m) =>
      m.javascript({ jsx: true, typescript: true }),
    ),

  rs: () => import("@codemirror/lang-rust").then((m) => m.rust()),
  go: () => import("@codemirror/lang-go").then((m) => m.go()),
  py: () => import("@codemirror/lang-python").then((m) => m.python()),
  json: () => import("@codemirror/lang-json").then((m) => m.json()),

  md: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
  markdown: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),

  html: () => import("@codemirror/lang-html").then((m) => m.html()),
  htm: () => import("@codemirror/lang-html").then((m) => m.html()),
  css: () => import("@codemirror/lang-css").then((m) => m.css()),

  php: () => import("@codemirror/lang-php").then((m) => m.php({ plain: true })),

  // C / C++ family
  c: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.c),
  h: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.c),
  cpp: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.cpp),
  cc: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.cpp),
  cxx: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.cpp),
  hpp: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.cpp),
  hxx: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.cpp),

  // Java
  java: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.java),

  // C#
  cs: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.csharp),

  // Kotlin / Scala (clike variants)
  kt: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.kotlin),
  kts: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.kotlin),
  scala: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.scala),
  // Objective-C
  m: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.objectiveC),
  mm: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.objectiveCpp),

  // Legacy-modes: loaders return the raw StreamParser; wrapped below.
  sh: () => import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell),
  bash: () =>
    import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell),
  zsh: () => import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell),
  fish: () => import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell),
  // Windows Batch — no legacy mode exists, so local/batchMode.ts supplies one.
  bat: () => import("./batchMode").then((m) => m.batch),
  cmd: () => import("./batchMode").then((m) => m.batch),
  toml: () => import("@codemirror/legacy-modes/mode/toml").then((m) => m.toml),
  yaml: () => import("@codemirror/legacy-modes/mode/yaml").then((m) => m.yaml),
  yml: () => import("@codemirror/legacy-modes/mode/yaml").then((m) => m.yaml),
  dockerfile: () =>
    import("@codemirror/legacy-modes/mode/dockerfile").then(
      (m) => m.dockerFile,
    ),

  // Ruby
  rb: () => import("@codemirror/legacy-modes/mode/ruby").then((m) => m.ruby),
  rake: () => import("@codemirror/legacy-modes/mode/ruby").then((m) => m.ruby),
  gemspec: () => import("@codemirror/legacy-modes/mode/ruby").then((m) => m.ruby),

  // Swift
  swift: () => import("@codemirror/legacy-modes/mode/swift").then((m) => m.swift),

  // Lua
  lua: () => import("@codemirror/legacy-modes/mode/lua").then((m) => m.lua),

  // SQL
  sql: () => import("@codemirror/legacy-modes/mode/sql").then((m) => m.standardSQL),

  // XML / SVG / XHTML
  xml: () => import("@codemirror/legacy-modes/mode/xml").then((m) => m.xml),
  xsl: () => import("@codemirror/legacy-modes/mode/xml").then((m) => m.xml),
  xsd: () => import("@codemirror/legacy-modes/mode/xml").then((m) => m.xml),
  svg: () => import("@codemirror/legacy-modes/mode/xml").then((m) => m.xml),
  xhtml: () => import("@codemirror/legacy-modes/mode/xml").then((m) => m.xml),
  plist: () => import("@codemirror/legacy-modes/mode/xml").then((m) => m.xml),

  // Perl
  pl: () => import("@codemirror/legacy-modes/mode/perl").then((m) => m.perl),
  pm: () => import("@codemirror/legacy-modes/mode/perl").then((m) => m.perl),

  // R
  r: () => import("@codemirror/legacy-modes/mode/r").then((m) => m.r),

  // Haskell
  hs: () => import("@codemirror/legacy-modes/mode/haskell").then((m) => m.haskell),

  // Erlang / Elixir
  erl: () => import("@codemirror/legacy-modes/mode/erlang").then((m) => m.erlang),

  // Clojure
  clj: () => import("@codemirror/legacy-modes/mode/clojure").then((m) => m.clojure),
  cljs: () => import("@codemirror/legacy-modes/mode/clojure").then((m) => m.clojure),
  cljc: () => import("@codemirror/legacy-modes/mode/clojure").then((m) => m.clojure),

  // Dart (clike variant)
  dart: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.dart),

  // PowerShell
  ps1: () => import("@codemirror/legacy-modes/mode/powershell").then((m) => m.powerShell),
  psm1: () => import("@codemirror/legacy-modes/mode/powershell").then((m) => m.powerShell),
  psd1: () => import("@codemirror/legacy-modes/mode/powershell").then((m) => m.powerShell),

  // Groovy / Gradle
  groovy: () => import("@codemirror/legacy-modes/mode/groovy").then((m) => m.groovy),
  gradle: () => import("@codemirror/legacy-modes/mode/groovy").then((m) => m.groovy),

  // Diff / Patch
  diff: () => import("@codemirror/legacy-modes/mode/diff").then((m) => m.diff),
  patch: () => import("@codemirror/legacy-modes/mode/diff").then((m) => m.diff),

  // CMake
  cmake: () => import("@codemirror/legacy-modes/mode/cmake").then((m) => m.cmake),

  // Nginx
  nginx: () => import("@codemirror/legacy-modes/mode/nginx").then((m) => m.nginx),

  // Protobuf
  proto: () => import("@codemirror/legacy-modes/mode/protobuf").then((m) => m.protobuf),

  // Julia
  jl: () => import("@codemirror/legacy-modes/mode/julia").then((m) => m.julia),

  // CoffeeScript
  coffee: () => import("@codemirror/legacy-modes/mode/coffeescript").then((m) => m.coffeeScript),

  // Sass / SCSS (stylus for .sass, css for .scss is already handled)
  sass: () => import("@codemirror/legacy-modes/mode/sass").then((m) => m.sass),
  scss: () => import("@codemirror/lang-css").then((m) => m.css()),

  // Verilog / VHDL
  v: () => import("@codemirror/legacy-modes/mode/verilog").then((m) => m.verilog),
  sv: () => import("@codemirror/legacy-modes/mode/verilog").then((m) => m.verilog),
  vhd: () => import("@codemirror/legacy-modes/mode/vhdl").then((m) => m.vhdl),
  vhdl: () => import("@codemirror/legacy-modes/mode/vhdl").then((m) => m.vhdl),

  // Fortran
  f90: () => import("@codemirror/legacy-modes/mode/fortran").then((m) => m.fortran),
  f95: () => import("@codemirror/legacy-modes/mode/fortran").then((m) => m.fortran),

  // Pascal
  pas: () => import("@codemirror/legacy-modes/mode/pascal").then((m) => m.pascal),

  // INI / properties / env / git config — all key=value, same mode.
  ini: () =>
    import("@codemirror/legacy-modes/mode/properties").then((m) => m.properties),
  properties: () =>
    import("@codemirror/legacy-modes/mode/properties").then((m) => m.properties),
  env: () =>
    import("@codemirror/legacy-modes/mode/properties").then((m) => m.properties),
  editorconfig: () =>
    import("@codemirror/legacy-modes/mode/properties").then((m) => m.properties),
  gitconfig: () =>
    import("@codemirror/legacy-modes/mode/properties").then((m) => m.properties),

  // LaTeX family
  tex: () => import("@codemirror/legacy-modes/mode/stex").then((m) => m.stex),
  latex: () => import("@codemirror/legacy-modes/mode/stex").then((m) => m.stex),
  sty: () => import("@codemirror/legacy-modes/mode/stex").then((m) => m.stex),
  cls: () => import("@codemirror/legacy-modes/mode/stex").then((m) => m.stex),
  bib: () => import("@codemirror/legacy-modes/mode/stex").then((m) => m.stex),

  // Tcl
  tcl: () => import("@codemirror/legacy-modes/mode/tcl").then((m) => m.tcl),

  // Visual Basic / VBScript
  vb: () => import("@codemirror/legacy-modes/mode/vb").then((m) => m.vb),
  vbs: () => import("@codemirror/legacy-modes/mode/vbscript").then((m) => m.vbScript),

  // HTTP request files (.http / .rest)
  http: () => import("@codemirror/legacy-modes/mode/http").then((m) => m.http),

  // Template languages
  pug: () => import("@codemirror/legacy-modes/mode/pug").then((m) => m.pug),
  jade: () => import("@codemirror/legacy-modes/mode/pug").then((m) => m.pug),
  jinja: () => import("@codemirror/legacy-modes/mode/jinja2").then((m) => m.jinja2),
  jinja2: () => import("@codemirror/legacy-modes/mode/jinja2").then((m) => m.jinja2),
  j2: () => import("@codemirror/legacy-modes/mode/jinja2").then((m) => m.jinja2),

  // More languages legacy-modes already ships
  crystal: () => import("@codemirror/legacy-modes/mode/crystal").then((m) => m.crystal),
  cr: () => import("@codemirror/legacy-modes/mode/crystal").then((m) => m.crystal),
  elm: () => import("@codemirror/legacy-modes/mode/elm").then((m) => m.elm),
  haxe: () => import("@codemirror/legacy-modes/mode/haxe").then((m) => m.haxe),
  lisp: () => import("@codemirror/legacy-modes/mode/commonlisp").then((m) => m.commonLisp),
  cl: () => import("@codemirror/legacy-modes/mode/commonlisp").then((m) => m.commonLisp),
  el: () => import("@codemirror/legacy-modes/mode/commonlisp").then((m) => m.commonLisp),
  scm: () => import("@codemirror/legacy-modes/mode/scheme").then((m) => m.scheme),
  ss: () => import("@codemirror/legacy-modes/mode/scheme").then((m) => m.scheme),
  nsi: () => import("@codemirror/legacy-modes/mode/nsis").then((m) => m.nsis),
  nsh: () => import("@codemirror/legacy-modes/mode/nsis").then((m) => m.nsis),
  s: () => import("@codemirror/legacy-modes/mode/gas").then((m) => m.gas),
  asm: () => import("@codemirror/legacy-modes/mode/gas").then((m) => m.gas),
  d: () => import("@codemirror/legacy-modes/mode/d").then((m) => m.d),
  styl: () => import("@codemirror/legacy-modes/mode/stylus").then((m) => m.stylus),
  stylus: () => import("@codemirror/legacy-modes/mode/stylus").then((m) => m.stylus),
  feature: () => import("@codemirror/legacy-modes/mode/gherkin").then((m) => m.gherkin),
  idl: () => import("@codemirror/legacy-modes/mode/idl").then((m) => m.idl),
  mathematica: () => import("@codemirror/legacy-modes/mode/mathematica").then((m) => m.mathematica),
  mll: () => import("@codemirror/legacy-modes/mode/mllike").then((m) => m.oCaml),
  ml: () => import("@codemirror/legacy-modes/mode/mllike").then((m) => m.oCaml),
  mli: () => import("@codemirror/legacy-modes/mode/mllike").then((m) => m.oCaml),
  fs: () => import("@codemirror/legacy-modes/mode/mllike").then((m) => m.fSharp),
  fsx: () => import("@codemirror/legacy-modes/mode/mllike").then((m) => m.fSharp),
  sml: () => import("@codemirror/legacy-modes/mode/mllike").then((m) => m.sml),
  ttl: () => import("@codemirror/legacy-modes/mode/turtle").then((m) => m.turtle),
  rq: () => import("@codemirror/legacy-modes/mode/sparql").then((m) => m.sparql),
  sparql: () => import("@codemirror/legacy-modes/mode/sparql").then((m) => m.sparql),
  cob: () => import("@codemirror/legacy-modes/mode/cobol").then((m) => m.cobol),
  tiddlywiki: () => import("@codemirror/legacy-modes/mode/tiddlywiki").then((m) => m.tiddlyWiki),
  wat: () => import("@codemirror/legacy-modes/mode/wast").then((m) => m.wast),
  wast: () => import("@codemirror/legacy-modes/mode/wast").then((m) => m.wast),
};

/** Files whose language is decided by NAME, not extension. Keys are the
 *  lowercase basename; `cacheKey` uses them before falling back to `extOf`. */
const filenameOverrides: Record<string, LanguageLoader> = {
  dockerfile: loaders.dockerfile!,
  "dockerfile.dev": loaders.dockerfile!,
  "dockerfile.prod": loaders.dockerfile!,
  containerfile: loaders.dockerfile!,
  // Batch entry point that usually has no extension.
  autorun: loaders.bat!,
  // CMake's canonical filename is .txt, which would resolve to no language.
  "cmakelists.txt": loaders.cmake!,
};

/** Lowercased final path segment. Splits on BOTH separators: editor paths
 *  are canonical forward-slash, but git/AI/OS callers can hand us a
 *  backslashed Windows path, and a Dockerfile under `C:\\repo\\` would
 *  otherwise never match its filename override. */
function basenameOf(name: string): string {
  const lower = name.toLowerCase();
  return lower.split(/[\\/]/).pop() ?? lower;
}

function extOf(name: string): string | null {
  const base = basenameOf(name);
  const dot = base.lastIndexOf(".");
  if (dot === -1 || dot === base.length - 1) return null;
  return base.slice(dot + 1);
}

function isStreamParser(v: unknown): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { token?: unknown }).token === "function"
  );
}

const cache = new Map<string, Extension | null>();

function cacheKey(filename: string): string | null {
  const base = basenameOf(filename);
  if (filenameOverrides[base]) return `name:${base}`;
  const ext = extOf(base);
  return ext ? `ext:${ext}` : null;
}

export function resolveLanguageSync(filename: string): Extension | null {
  const key = cacheKey(filename);
  return key ? (cache.get(key) ?? null) : null;
}

export async function resolveLanguage(
  filename: string,
): Promise<Extension | null> {
  const key = cacheKey(filename);
  if (!key) return null;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const base = basenameOf(filename);
  const loader = filenameOverrides[base] ?? loaders[extOf(base) ?? ""];
  if (!loader) {
    cache.set(key, null);
    return null;
  }

  const result = await loader();
  let ext: Extension;
  if (isStreamParser(result)) {
    const { StreamLanguage } = await import("@codemirror/language");
    ext = StreamLanguage.define(
      result as Parameters<typeof StreamLanguage.define>[0],
    );
  } else {
    ext = result as Extension;
  }
  // Safe to store: CM6 language extensions (LanguageSupport + the language
  // itself) are stateless configuration — the same extension value can be
  // installed in any number of EditorStates.
  cache.set(key, ext);
  return ext;
}

export function preloadLanguages(filenames: string[]): void {
  for (const f of filenames) {
    void resolveLanguage(f).catch(() => {});
  }
}
