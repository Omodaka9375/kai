import { Folder01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IconSvgElement } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ProjectSwitcherItem } from "./ProjectRail";
import {
  CURATED_PROJECT_ICONS,
  PROJECT_ICON_COLORS,
  getFullPack,
  iconDisplayName,
  loadFullPack,
  projectIconCss,
  subscribeFullPack,
  useProjectIcon,
} from "./projectIcons";

/** How many search hits to render before cutting off (the pack has ~5,100
 * glyphs; a flat grid of all of them would jank the dialog on every key). */
const SEARCH_RESULT_CAP = 240;

/** Right-click "Change icon" picker for a project tile (2026-11-11).
 *
 * Two tiers, per the agreed hybrid design: the curated grid is always
 * visible (zero load cost), the search field fans out over the FULL free
 * pack which is code-split behind loadFullPack() and only fetched the
 * first time the dialog opens.
 *
 * Apply model: clicking a glyph applies icon+color and CLOSES (quickpick);
 * clicking a color swatch applies the color and keeps the dialog open so
 * the glyph can still be picked. "Auto" swatch returns the color to the
 * project's deterministic hash hue. */
export function ProjectIconPicker({
  project,
  onOpenChange,
  onChange,
}: {
  project: ProjectSwitcherItem | null;
  onOpenChange: (open: boolean) => void;
  onChange: (icon: string | null, color: string | null) => void;
}) {
  const open = project !== null;
  const [query, setQuery] = useState("");
  const [pendingColor, setPendingColor] = useState<string | null>(null);
  // Re-render when the lazy pack lands (search results depend on it).
  const [packReady, setPackReady] = useState(() => getFullPack() !== null);
  useEffect(() => {
    if (!open) return;
    if (getFullPack()) {
      setPackReady(true);
      return;
    }
    void loadFullPack();
    return subscribeFullPack(() => setPackReady(true));
  }, [open]);

  // Reset per-open state when a new project opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setPendingColor(project?.color ?? "auto");
    }
  }, [open, project]);

  const pack = getFullPack();
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !pack) return null;
    return Object.keys(pack)
      .filter((name) => iconDisplayName(name).toLowerCase().includes(q))
      .slice(0, SEARCH_RESULT_CAP);
    // packReady is the render signal; pack identity is stable once loaded.
  }, [query, pack, packReady]);

  const previewIcon = useProjectIcon(project?.icon ?? undefined);

  if (!project) return null;
  const previewColor = projectIconCss(
    pendingColor && pendingColor !== "auto" ? pendingColor : undefined,
    project.id,
  );

  const applyColor = (color: string) => {
    setPendingColor(color);
    // Keep the glyph; "auto" resets to the hash hue (null deletes the key).
    onChange(project.icon ?? null, color === "auto" ? null : color);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-3">
        <DialogHeader>
          <DialogTitle>Icon for {project.name}</DialogTitle>
          <DialogDescription>
            Pick a glyph and a color. The tile falls back to the folder icon
            and its automatic hue when nothing is set.
          </DialogDescription>
        </DialogHeader>

        {/* Live preview: the tile is 17px, so the choice needs a bigger
            surface to be judgeable. */}
        <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-accent/40 px-3 py-2">
          <span
            className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-card"
            style={{ color: previewColor }}
          >
            <HugeiconsIcon
              icon={previewIcon ?? Folder01Icon}
              size={22}
              strokeWidth={1.75}
            />
          </span>
          <div className="min-w-0 text-xs">
            <div className="truncate font-medium">{project.name}</div>
            <div className="text-muted-foreground">
              {project.icon ? iconDisplayName(project.icon) : "Folder (default)"}
              {" · "}
              {pendingColor === "auto" ? "auto color" : pendingColor}
            </div>
          </div>
        </div>

        {/* Color row: Auto + the 8 preset hues, all in the muted 45%/52%
            family the rail already uses. */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            aria-label="Automatic color"
            title="Automatic color"
            onClick={() => applyColor("auto")}
            className={cn(
              "flex size-6 items-center justify-center rounded-full border text-[9px] font-medium",
              (pendingColor ?? "auto") === "auto"
                ? "border-foreground/70 ring-2 ring-primary/40"
                : "border-border/70",
            )}
            style={{
              color: projectIconCss(undefined, project.id),
              background: "color-mix(in srgb, currentColor 25%, transparent)",
            }}
          >
            A
          </button>
          {PROJECT_ICON_COLORS.map((preset) => (
            <button
              key={preset.key}
              type="button"
              aria-label={preset.label}
              title={preset.label}
              onClick={() => applyColor(preset.key)}
              className={cn(
                "size-6 rounded-full border transition-transform hover:scale-110",
                pendingColor === preset.key
                  ? "border-foreground/70 ring-2 ring-primary/40"
                  : "border-border/70",
              )}
              style={{ background: projectIconCss(preset.key, project.id) }}
            />
          ))}
        </div>

        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={pack ? "Search all icons…" : "Search all icons… (loading pack)"}
          className="h-8 text-xs"
        />

        <div className="min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-width:thin]">
          {results === null ? (
            CURATED_PROJECT_ICONS.map((section) => (
              <div key={section.group} className="mb-3">
                <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {section.group}
                </div>
                <div className="grid grid-cols-8 gap-1">
                  {Object.entries(section.icons).map(([name, icon]) => (
                    <IconCell
                      key={name}
                      name={name}
                      icon={icon}
                      selected={project.icon === name}
                      color={previewColor}
                      onSelect={() => {
                        // Quickpick: glyph + current color, close.
                        const color = pendingColor === "auto" ? null : pendingColor;
                        onChange(name, color);
                        onOpenChange(false);
                      }}
                    />
                  ))}
                </div>
              </div>
            ))
          ) : results.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              No icons match "{query}".
            </div>
          ) : (
            <div className="grid grid-cols-8 gap-1">
              {results.map((name) => (
                <SearchIconCell
                  key={name}
                  name={name}
                  selected={project.icon === name}
                  color={previewColor}
                  onSelect={() => {
                    const color = pendingColor === "auto" ? null : pendingColor;
                    onChange(name, color);
                    onOpenChange(false);
                  }}
                />
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end">
          <DialogClose asChild>
            <Button variant="outline" size="sm">
              Done
            </Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function IconCell({
  name,
  icon,
  selected,
  color,
  onSelect,
}: {
  name: string;
  icon: IconSvgElement;
  selected: boolean;
  color: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      title={iconDisplayName(name)}
      aria-label={iconDisplayName(name)}
      onClick={onSelect}
      className={cn(
        "flex size-9 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        selected && "border-primary/60 bg-accent text-foreground",
      )}
    >
      <HugeiconsIcon icon={icon} size={17} strokeWidth={1.75} style={{ color }} />
    </button>
  );
}

/** Search-result cell: the glyph lives in the lazy pack and resolves
 * through the same hook the tile uses, so results appear as the chunk
 * arrives. */
function SearchIconCell({
  name,
  selected,
  color,
  onSelect,
}: {
  name: string;
  selected: boolean;
  color: string;
  onSelect: () => void;
}) {
  const icon = useProjectIcon(name);
  if (!icon) {
    return <span className="flex size-9 animate-pulse items-center justify-center rounded-md bg-muted/40" />;
  }
  return <IconCell name={name} icon={icon} selected={selected} color={color} onSelect={onSelect} />;
}
