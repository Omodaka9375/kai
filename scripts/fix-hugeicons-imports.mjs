// One-off: convert static named imports from the hugeicons index to
// per-icon deep imports so the index module is ONLY dynamically referenced
// and the 5,100-icon pack can stay in its own lazy chunk.
// Names that exist only as index ALIASES (e.g. `Download01Icon as
// DownloadIcon`) are resolved through dist/types/index.d.ts and imported
// from the real per-icon file under the original local name.
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const ESM = "node_modules/@hugeicons/core-free-icons/dist/esm";
const DTS = "node_modules/@hugeicons/core-free-icons/dist/types/index.d.ts";
const dts = readFileSync(DTS, "utf8");
const SKIP = new Set(["projectIcons.test.ts"]);
const changed = [];

function resolveModule(name, file) {
  if (existsSync(join(ESM, `${name}.js`))) return name;
  // Alias: find `<RealIcon> as <name>` in the index export block.
  const m = dts.match(new RegExp(`\\b([A-Za-z0-9]+Icon) as ${name}\\b`));
  if (m && existsSync(join(ESM, `${m[1]}.js`))) return m[1];
  throw new Error(`${file}: ${name} has no per-icon module and is not a known alias`);
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(entry) && !SKIP.has(entry)) scan(p);
  }
}

function scan(file) {
  const src = readFileSync(file, "utf8");
  let out = src;
  let touched = false;
  out = out.replace(
    /import\s*\{([^}]+?)\}\s*from\s*["']@hugeicons\/core-free-icons["'];?/g,
    (_, names) => {
      touched = true;
      const lines = names
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean)
        .map((n) => {
          const real = resolveModule(n, file);
          if (real === n) return `import ${n} from "@hugeicons/core-free-icons/${n}";`;
          return `import ${n} from "@hugeicons/core-free-icons/${real}";`;
        });
      return lines.join("\n");
    },
  );
  if (touched) {
    writeFileSync(file, out);
    changed.push(file);
  }
}

walk("src");
console.log(`converted ${changed.length} files`);
for (const f of changed) console.log("  " + f);
