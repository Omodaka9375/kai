import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { McpServerConfig } from "@/modules/ai/lib/mcp";
import {
  isValidHandle,
  normalizeHandle,
  type Skill,
} from "@/modules/ai/lib/skills";
import { useMcpStore } from "@/modules/ai/store/mcpStore";
import { useSkillsStore } from "@/modules/ai/store/skillsStore";
import Add01Icon from "@hugeicons/core-free-icons/Add01Icon";
import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon";
import Edit02Icon from "@hugeicons/core-free-icons/Edit02Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}

/**
 * Skills settings (2026-11-02) — the management surface for the
 * folder-based skills system. Replaces the Snippets section: same editor
 * shape (handle / name / description / content), now writing SKILL.md
 * folders in the GLOBAL scope (~/.kai/skills — every project) instead of
 * kai-snippets.json rows. Project-scope skills are per-repo files
 * (<root>/.kai/skills) — edit them in the repo, not here.
 */
export function SkillsSection() {
  const skills = useSkillsStore((s) => s.globalSkills);
  const hydrateSkills = useSkillsStore((s) => s.hydrate);
  const upsertSkill = useSkillsStore((s) => s.upsert);
  const removeSkill = useSkillsStore((s) => s.remove);
  const mcpServers = useMcpStore((s) => s.servers);
  const hydrateMcp = useMcpStore((s) => s.hydrate);

  useEffect(() => {
    void hydrateSkills(null);
    void hydrateMcp();
  }, [hydrateSkills, hydrateMcp]);

  const [editing, setEditing] = useState<Skill | null>(null);

  return (
    <div className="flex flex-col gap-7">
      <SectionHeader
        title="Skills"
        description="Reusable capabilities you can drop into any prompt, in any project."
      />

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex flex-col">
            <Label>Skills</Label>
            <span className="text-[10.5px] text-muted-foreground">
              Drop into any prompt with{" "}
              <code className="rounded bg-muted/50 px-1 font-mono">
                #handle
              </code>
              . Stored as folders in{" "}
              <code className="font-mono">~/.kai/skills</code> — every
              project sees them. Project skills live in{" "}
              <code className="font-mono">.kai/skills</code> in the repo.
            </span>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2 text-[11px]"
            onClick={() =>
              setEditing({
                name: "",
                handle: "",
                description: "",
                content: "",
                mcpServers: [],
                agentHidden: false,
                scope: "global",
                dir: "",
                skillMdPath: "",
              })
            }
          >
            <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={1.75} />
            New skill
          </Button>
        </div>

        {skills.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 bg-card/30 px-4 py-6 text-center text-[11px] text-muted-foreground">
            No skills yet. Create one and insert it with{" "}
            <code className="font-mono">#handle</code> in the AI input.
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {skills.map((s) => (
              <li
                key={s.name}
                className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2"
              >
                <code className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                  #{s.handle}
                </code>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[12px] font-medium">
                    {s.name}
                  </span>
                  {s.description ? (
                    <span className="truncate text-[10.5px] text-muted-foreground">
                      {s.description}
                    </span>
                  ) : null}
                </div>
                {s.agentHidden ? (
                  <span
                    className="text-[10px] text-muted-foreground"
                    title="Hidden from the agent's list_skills; #handle only"
                  >
                    handle-only
                  </span>
                ) : null}
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  onClick={() => setEditing(s)}
                  title="Edit"
                >
                  <HugeiconsIcon
                    icon={Edit02Icon}
                    size={12}
                    strokeWidth={1.75}
                  />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 text-muted-foreground hover:text-destructive"
                  onClick={() => void removeSkill(s.name, "global")}
                  title="Delete"
                >
                  <HugeiconsIcon
                    icon={Delete02Icon}
                    size={12}
                    strokeWidth={1.75}
                  />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <SkillEditorDialog
        skill={editing}
        existing={skills}
        mcpServers={mcpServers}
        onClose={() => setEditing(null)}
        onSave={(s) => {
          void upsertSkill(
            {
              name: s.name,
              handle: s.handle,
              description: s.description,
              content: s.content,
              mcpServers: s.mcpServers,
              agentHidden: s.agentHidden,
            },
            "global",
          );
          setEditing(null);
        }}
      />
    </div>
  );
}

function SkillEditorDialog({
  skill,
  existing,
  mcpServers,
  onClose,
  onSave,
}: {
  skill: Skill | null;
  existing: Skill[];
  mcpServers: McpServerConfig[];
  onClose: () => void;
  onSave: (s: Skill) => void;
}) {
  const [draft, setDraft] = useState<Skill | null>(skill);
  useEffect(() => setDraft(skill), [skill]);
  if (!draft) return null;

  const handleErr = !draft.handle
    ? "Required."
    : !isValidHandle(draft.handle)
      ? "Lowercase letters, digits, and dashes only."
      : existing.some((s) => s.name !== draft.name && s.handle === draft.handle)
        ? "Already in use."
        : null;
  const canSave =
    !handleErr &&
    draft.name.trim().length > 0 &&
    draft.content.trim().length > 0 &&
    draft.description.trim().length > 0;

  return (
    <Dialog open={!!skill} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[14px]">
            {existing.some((s) => s.name === draft.name)
              ? "Edit skill"
              : "New skill"}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 max-h-[60vh] overflow-y-auto pr-1 scrollbar-thin">
          <div className="flex gap-2">
            <div className="flex w-32 flex-col gap-1">
              <Label>Handle</Label>
              <div className="relative">
                <span className="absolute top-1/2 left-2 -translate-y-1/2 font-mono text-[11.5px] text-muted-foreground">
                  #
                </span>
                <Input
                  value={draft.handle}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      handle: normalizeHandle(e.target.value),
                    })
                  }
                  placeholder="review"
                  className="h-8 pl-5 font-mono text-[11.5px]"
                />
              </div>
              {handleErr ? (
                <span className="text-[10px] text-destructive">
                  {handleErr}
                </span>
              ) : null}
            </div>
            <div className="flex flex-1 flex-col gap-1">
              <Label>Skill name</Label>
              <Input
                value={draft.name}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    // Folder name — keep it in the handle alphabet.
                    name: normalizeHandle(e.target.value),
                  })
                }
                placeholder="e.g. deploy-status"
                className="h-8 font-mono text-[12px]"
              />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label>Description</Label>
            <Input
              value={draft.description}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
              placeholder="One line — shown in the # picker and in list_skills"
              className="h-8 text-[12px]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label>Instructions</Label>
            <Textarea
              value={draft.content}
              onChange={(e) => setDraft({ ...draft, content: e.target.value })}
              placeholder="Inserted into the prompt as a <skill> block when you use #handle."
              className="min-h-40 max-h-64 resize-y overflow-y-auto break-words font-mono text-[11.5px] leading-relaxed"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="flex flex-col">
              <Label>Agent discovery</Label>
              <span className="text-[10px] text-muted-foreground">
                Off = this skill is #handle-only (hidden from the agent's
                list_skills).
              </span>
            </div>
            <button
              type="button"
              onClick={() => setDraft({ ...draft, agentHidden: !draft.agentHidden })}
              className={cn(
                "rounded-md border px-2 py-1 text-[11px] transition-colors",
                draft.agentHidden
                  ? "border-foreground/40 bg-accent font-medium"
                  : "border-border/60 text-muted-foreground hover:bg-accent/40",
              )}
            >
              {draft.agentHidden ? "Handle-only" : "Discoverable"}
            </button>
          </div>
          {mcpServers.length > 0 && (
            <div className="flex flex-col gap-1">
              <Label>MCP Servers</Label>
              <div className="flex flex-wrap gap-1.5">
                {mcpServers.map((s) => {
                  const active = draft.mcpServers.includes(s.id);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => {
                        const next = active
                          ? draft.mcpServers.filter((id) => id !== s.id)
                          : [...draft.mcpServers, s.id];
                        setDraft({ ...draft, mcpServers: next });
                      }}
                      className={cn(
                        "rounded-md border px-2 py-1 text-[11px] transition-colors",
                        active
                          ? "border-foreground/40 bg-accent font-medium"
                          : "border-border/60 text-muted-foreground hover:bg-accent/40",
                      )}
                    >
                      {s.name || "Unnamed"}
                    </button>
                  );
                })}
              </div>
              <span className="text-[10px] text-muted-foreground">
                Select servers whose tools should activate when this skill is used.
              </span>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canSave} onClick={() => onSave(draft)}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
