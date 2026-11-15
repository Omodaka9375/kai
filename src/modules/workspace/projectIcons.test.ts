import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as fullPack from "@hugeicons/core-free-icons";
import {
  CURATED_PROJECT_ICONS,
  PROJECT_ICON_COLORS,
  autoProjectIconColor,
  iconDisplayName,
  projectIconCss,
} from "./projectIcons";

const rail = readFileSync(new URL("./ProjectRail.tsx", import.meta.url), "utf8") as string;
const picker = readFileSync(new URL("./ProjectIconPicker.tsx", import.meta.url), "utf8") as string;
const shell = readFileSync(new URL("../../app/AppShell.tsx", import.meta.url), "utf8") as string;
const menu = readFileSync(new URL("../../app/projectsMenu.ts", import.meta.url), "utf8") as string;

describe("project icon customization (2026-11-11)", () => {
  it("every curated glyph exists in the free pack (no dead tiles)", () => {
    for (const section of CURATED_PROJECT_ICONS) {
      for (const name of Object.keys(section.icons)) {
        expect(name, `${section.group}/${name}`).toMatch(/Icon$/);
        expect(fullPack, name).toHaveProperty(name);
        // The static object and the pack entry must be the SAME glyph.
        expect(section.icons[name], name).toBe((fullPack as Record<string, unknown>)[name]);
      }
    }
  });

  it("curated groups are non-empty and the set is a meaningful quickpick size", () => {
    expect(CURATED_PROJECT_ICONS.length).toBeGreaterThanOrEqual(5);
    const total = CURATED_PROJECT_ICONS.reduce((n, s) => n + Object.keys(s.icons).length, 0);
    expect(total).toBeGreaterThanOrEqual(40);
  });

  it("color presets stay in the muted rail family and resolve", () => {
    expect(PROJECT_ICON_COLORS).toHaveLength(8);
    expect(projectIconCss("emerald", "p1")).toBe("hsl(152 45% 52%)");
    // Unknown keys and "auto" fall back to the deterministic hash hue.
    expect(projectIconCss("chartreuse", "p1")).toBe(autoProjectIconColor("p1"));
    expect(projectIconCss("auto", "p1")).toBe(autoProjectIconColor("p1"));
    expect(projectIconCss(undefined, "p1")).toBe(autoProjectIconColor("p1"));
    expect(autoProjectIconColor("p1")).toMatch(/^hsl\(\d+ 45% 52%\)$/);
  });

  it("strips the Icon suffix for display only", () => {
    expect(iconDisplayName("RocketIcon")).toBe("Rocket");
    expect(iconDisplayName("Folder01Icon")).toBe("Folder01");
  });

  it("the rail routes the picker through the menu action, not local state", () => {
    expect(rail).toContain("menu?.changeProjectIcon(iconPickerFor, icon, color)");
    expect(rail).toContain("Change icon...");
    expect(rail).toContain("Reset to default");
    // Only offered when something is customized.
    expect(rail).toContain("{project.icon || project.color ? (");
    expect(rail).toContain("<TileGlyph project={project} active={project.active} />");
  });

  it("the picker searches the FULL lazy pack, not just curated", () => {
    expect(picker).toContain("loadFullPack()");
    expect(picker).toContain("SEARCH_RESULT_CAP");
    // Glyph click applies and closes (quickpick); color click stays open.
    expect(picker).toMatch(/onSelect=\{\(\) => \{\s*\/\/ Quickpick/);
  });

  it("no src file statically imports the hugeicons INDEX (only deep imports)", () => {
    // The index module must stay referenced ONLY by the dynamic
    // loadFullPack() import. Any static named import from
    // "@hugeicons/core-free-icons" pulls the index into the eager chunk
    // graph, and the whole ~5MB pack then welds itself into the initial
    // load (verified on real dist output, 2026-11-11). If a new import is
    // needed, use the per-icon deep import form:
    //   import RocketIcon from "@hugeicons/core-free-icons/RocketIcon";
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(entry) && entry !== "projectIcons.test.ts") {
          if (readFileSync(p, "utf8").includes('from "@hugeicons/core-free-icons"')) {
            offenders.push(p);
          }
        }
      }
    };
    walk(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    expect(offenders).toEqual([]);
  });

  it("every deep per-icon hugeicons import resolves to a real file", () => {
    // Why this exists: `@hugeicons/core-free-icons` ships an ambient
    // wildcard type (src/vite-env.d.ts) so `import Foo from
    // "@hugeicons/core-free-icons/Foo"` typechecks for ANY name, and its
    // barrel re-exports ALIASES that have no per-icon file. A name can be
    // present in `fullPack` (so the curated-glyph test above passes) and
    // still fail to resolve at build time. That exact hole shipped:
    // StaffSection imported HistoryIcon, which the index defines but
    // dist/esm/ has no file for, and `vite build` died on it while tsc stayed
    // green. Only Rollup reads the package's `exports` map, so we assert
    // against the same on-disk files here — turning a minutes-long release
    // build failure into a sub-second test failure.
    const esmDir = new URL(
      "../../../node_modules/@hugeicons/core-free-icons/dist/esm",
      import.meta.url,
    ).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    expect(existsSync(esmDir)).toBe(true); // sanity: package layout changed
    // The predicate must actually discriminate, or "no missing imports" is
    // vacuous. HistoryIcon is the real regression: exported by the barrel,
    // absent as a per-icon file. If the pack ever ships it properly, drop this
    // line — its only job is to prove the check below can fail.
    expect(existsSync(join(esmDir, "NotebookIcon.js"))).toBe(true);
    expect(existsSync(join(esmDir, "HistoryIcon.js"))).toBe(false);

    const missing: string[] = [];
    let scanned = 0;
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(entry)) {
          const src = readFileSync(p, "utf8");
          // Real import statements only — ignore the specifier appearing in
          // prose/comments (e.g. the example above).
          const re = /import\s+(?:type\s+)?[A-Za-z0-9_]+\s+from\s+"@hugeicons\/core-free-icons\/([A-Za-z0-9]+)"/g;
          for (const m of src.matchAll(re)) {
            scanned += 1;
            const name = m[1]!;
            if (!existsSync(join(esmDir, `${name}.js`))) {
              missing.push(`${name}  <-  ${p.replace(/\\/g, "/").split("/src/")[1] ?? p}`);
            }
          }
        }
      }
    };
    // Whole src tree (NOT just src/modules): the shipped break was in
    // src/settings/sections/StaffSection.tsx, outside the modules subtree.
    walk(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    // Non-vacuity: the tree has hundreds of these imports, so a count near
    // zero means the regex or the walk root broke — a gate that scans nothing
    // would "pass" forever while shipping another HistoryIcon.
    expect(scanned).toBeGreaterThan(100);
    expect(missing).toEqual([]);
  });

  it("AppShell persists overrides under a dedicated key keyed by canonical root", () => {
    expect(shell).toContain('openProjectsStore.get<Record<string, { icon?: string; color?: string }>>("projectIcons")');
    expect(shell).toContain('void openProjectsStore.set("projectIcons", projectIconOverrides);');
    expect(shell).toContain("function projectIconOverrideKey(root: string): string {");
    // Items carry the override into the rail.
    expect(shell).toContain("icon: iconOverride?.icon,");
    expect(shell).toContain("color: iconOverride?.color,");
    expect(menu).toContain("changeProjectIcon: (id: string, icon: string | null, color: string | null) => void;");
  });
});
