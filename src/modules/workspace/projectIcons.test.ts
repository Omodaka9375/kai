import { readFileSync } from "node:fs";
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
