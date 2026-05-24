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
};

const filenameOverrides: Record<string, LanguageLoader> = {
  dockerfile: loaders.dockerfile!,
  "dockerfile.dev": loaders.dockerfile!,
};

function extOf(name: string): string | null {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot === -1 || dot === lower.length - 1) return null;
  return lower.slice(dot + 1);
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
  const lower = filename.toLowerCase();
  const base = lower.split("/").pop() ?? lower;
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

  const lower = filename.toLowerCase();
  const base = lower.split("/").pop() ?? lower;
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
  cache.set(key, ext);
  return ext;
}

export function preloadLanguages(filenames: string[]): void {
  for (const f of filenames) {
    void resolveLanguage(f).catch(() => {});
  }
}
