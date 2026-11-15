import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { AGENT_ICONS } from "@/modules/ai/components/AgentSwitcher";
import { BUILTIN_AGENTS, type Agent } from "@/modules/ai/lib/agents";
import {
  listReminders,
  type Reminder,
} from "@/modules/ai/lib/reminders";
import {
  sessionEventsRecent,
  sessionJournalList,
  summarizeJournal,
  type JournalInfo,
  type JournalSummary,
  type SessionJournalEntry,
} from "@/modules/ai/lib/sessionEvents";
import { relativeTime } from "@/modules/ai/lib/relativeTime";
import { useAgentsStore } from "@/modules/ai/store/agentsStore";
import { useMcpStore } from "@/modules/ai/store/mcpStore";
import { useSkillsStore } from "@/modules/ai/store/skillsStore";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import Calendar01Icon from "@hugeicons/core-free-icons/Calendar01Icon";
import HistoryIcon from "@hugeicons/core-free-icons/HistoryIcon";
import LockKeyIcon from "@hugeicons/core-free-icons/LockKeyIcon";
import PuzzleIcon from "@hugeicons/core-free-icons/PuzzleIcon";
import SparklesIcon from "@hugeicons/core-free-icons/SparklesIcon";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";

/**
 * Staff — a single honest inventory of everything the agent can reach and
 * leave behind: personas, reusable skills, connected tool servers, scheduled
 * reminders, and the per-session journal (what each run actually saw).
 *
 * Scope (v1, D3): INVENTORY, not attribution. There is currently no
 * created-by field on any of these records — a persona, skill, or MCP server
 * the agent made is byte-identical to one you added by hand — so nothing here
 * claims who made what. That would be fiction. Provenance is a deliberate
 * follow-up: add `createdBy` at the three choke points (agentsStore.upsert,
 * tools/mcpTools.ts, tools/skills.ts) and these rows light up with it.
 *
 * The audit / denial log lives in the Security panel (it is the same append-
 * only trail); we link there rather than render a second copy.
 *
 * Everything shown hydrates from disk on mount, so this reads correctly in
 * the standalone Settings webview (which does not share the main window's
 * in-memory singletons — e.g. live watches and live MCP socket state are
 * owned by the main window and are intentionally not shown as if known here).
 */

const ROW_ICON = "shrink-0 text-muted-foreground";

/** One compact list line: [icon] title ......... meta */
function ItemRow({
  icon,
  title,
  meta,
  detail,
  onClick,
}: {
  icon?: React.ReactNode;
  title: string;
  meta?: string;
  detail?: React.ReactNode;
  onClick?: () => void;
}) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg border border-border/50 bg-card/50 px-3 py-2 text-left",
        onClick && "transition-colors hover:bg-accent/60",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
        {title}
      </span>
      {detail}
      {meta ? (
        <span className="shrink-0 text-[10.5px] text-muted-foreground">
          {meta}
        </span>
      ) : null}
    </Comp>
  );
}

function GroupLabel({
  children,
  count,
}: {
  children: React.ReactNode;
  count?: number;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {children}
      </span>
      {count !== undefined ? (
        <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
          {count}
        </span>
      ) : null}
    </div>
  );
}

function Section({
  label,
  count,
  empty,
  children,
}: {
  label: string;
  count: number;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <GroupLabel count={count}>{label}</GroupLabel>
      {count === 0 ? (
        <div className="rounded-lg border border-dashed border-border/60 bg-card/30 px-3 py-3 text-[11px] text-muted-foreground">
          {empty}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">{children}</div>
      )}
    </section>
  );
}

function PersonGlyph({ agent }: { agent: Agent }) {
  const Icon = AGENT_ICONS[agent.icon] ?? SparklesIcon;
  return (
    <HugeiconsIcon
      icon={Icon}
      size={14}
      strokeWidth={1.75}
      className={cn(ROW_ICON, "text-foreground/70")}
    />
  );
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One journal row's lazily-computed roll-up. */
type JournalRow = { info: JournalInfo; summary: JournalSummary };

/** The per-kind label + tint for the journal detail list. */
const EVENT_STYLE: Record<string, { label: string; cls: string }> = {
  turn: { label: "turn", cls: "text-foreground/70" },
  compact: { label: "compact", cls: "text-blue-600 dark:text-blue-400" },
  summarize: { label: "summarize", cls: "text-blue-600 dark:text-blue-400" },
  "vision-ocr": { label: "vision", cls: "text-blue-600 dark:text-blue-400" },
  retry: { label: "retry", cls: "text-amber-600 dark:text-amber-400" },
  "loop-nudge": { label: "loop", cls: "text-red-600 dark:text-red-400" },
};

function eventLine(ev: SessionJournalEntry): string {
  switch (ev.kind) {
    case "turn":
      return `${ev.modelId} · ${ev.messageCount} msgs · ${ev.toolNames.length} tools${
        ev.autoApprove && ev.autoApprove !== "off" ? ` · auto:${ev.autoApprove}` : ""
      }`;
    case "compact":
      return `dropped ${ev.droppedCount} (limit ${ev.contextLimit})`;
    case "summarize":
      return `${ev.fromCount} → ${ev.toCount} (${ev.trigger})`;
    case "vision-ocr":
      return `${ev.swappedParts} image part(s) swapped`;
    case "retry":
      return `attempt ${ev.attempt}: ${ev.reason}`;
    case "loop-nudge":
      return `${ev.toolName} repeated ${ev.repeatCount}×`;
    default:
      return "";
  }
}

const MAX_ROWS = 20;

export function StaffSection() {
  const customAgents = useAgentsStore((s) => s.customAgents);
  const hydrateAgents = useAgentsStore((s) => s.hydrate);
  const globalSkills = useSkillsStore((s) => s.globalSkills);
  const hydrateSkills = useSkillsStore((s) => s.hydrate);
  const mcpServers = useMcpStore((s) => s.servers);
  const hydrateMcp = useMcpStore((s) => s.hydrate);

  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [journals, setJournals] = useState<JournalRow[] | null>(null);
  const [journalError, setJournalError] = useState(false);
  const [openJournal, setOpenJournal] = useState<JournalRow | null>(null);

  useEffect(() => {
    void hydrateAgents();
    void hydrateSkills(null);
    void hydrateMcp();
    listReminders().then(setReminders).catch(() => setReminders([]));
  }, [hydrateAgents, hydrateSkills, hydrateMcp]);

  // Journals: one metadata call, then roll up the most recent sessions. Bounded
  // to MAX_ROWS so opening the panel never fans out over hundreds of files;
  // older sessions stay on disk and simply aren't summarized in the glance.
  const loadJournals = useCallback(() => {
    setJournals(null);
    setJournalError(false);
    void sessionJournalList()
      .then(async (list) => {
        const head = list.slice(0, MAX_ROWS);
        const rows = await Promise.all(
          head.map(async (info) => {
            const evs = await sessionEventsRecent(info.sessionId, 500).catch(
              () => [] as SessionJournalEntry[],
            );
            return { info, summary: summarizeJournal(evs) } as JournalRow;
          }),
        );
        setJournals(rows);
      })
      .catch(() => setJournalError(true));
  }, []);

  useEffect(() => {
    loadJournals();
  }, [loadJournals]);

  // Merge built-in + custom exactly like AgentsSection (a custom record that
  // shares a builtin id overrides it rather than duplicating the row).
  const agents = useMemo<Agent[]>(() => {
    const overridden = new Map(customAgents.map((c) => [c.id, c]));
    const builtins = BUILTIN_AGENTS.map((b) => {
      const o = overridden.get(b.id);
      return o ? { ...o, builtIn: true } : b;
    });
    const customs = customAgents.filter(
      (c) => !BUILTIN_AGENTS.some((b) => b.id === c.id),
    );
    return [...builtins, ...customs];
  }, [customAgents]);

  const pendingReminders = reminders.filter((r) => r.status === "pending");

  return (
    <div className="flex flex-col gap-7">
      <SectionHeader
        title="Staff"
        description="Everything the agent can reach and leave behind, in one place: personas, reusable skills, connected tool servers, scheduled reminders, and the per-session journal. Inventory only — KAI does not yet record who created each item, so no row here claims an author."
      />

      {/* Sessions & journals first: it is the surface found nowhere else. */}
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <GroupLabel count={journals?.length ?? 0}>Sessions & journals</GroupLabel>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[10.5px]"
            onClick={loadJournals}
          >
            Refresh
          </Button>
        </div>
        {journalError ? (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-600 dark:text-red-400">
            Could not read the journal folder.
          </div>
        ) : journals === null ? (
          <div className="py-6 text-center text-[11.5px] text-muted-foreground">
            Loading…
          </div>
        ) : journals.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 bg-card/30 px-3 py-3 text-[11px] text-muted-foreground">
            No session journals yet. Each chat run records what the model
            actually saw here.
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {journals.map(({ info, summary }) => (
              <ItemRow
                key={info.sessionId}
                icon={
                  <HugeiconsIcon
                    icon={HistoryIcon}
                    size={14}
                    strokeWidth={1.75}
                    className={ROW_ICON}
                  />
                }
                title={info.sessionId}
                onClick={() => setOpenJournal({ info, summary })}
                detail={
                  <span className="hidden shrink-0 items-center gap-2 text-[10.5px] text-muted-foreground sm:flex">
                    <span>{summary.turns} turns</span>
                    {summary.anomalies > 0 ? (
                      <span className="text-amber-600 dark:text-amber-400">
                        {summary.anomalies} flag{summary.anomalies > 1 ? "s" : ""}
                      </span>
                    ) : null}
                  </span>
                }
                meta={relativeTime(info.mtimeMs)}
              />
            ))}
          </div>
        )}
      </section>

      <Section
        label="Personas"
        count={agents.length}
        empty="No personas."
      >
        {agents.map((a) => (
          <ItemRow
            key={a.id}
            icon={<PersonGlyph agent={a} />}
            title={a.name}
            meta={a.builtIn ? "built-in" : "custom"}
            detail={
              <span className="shrink-0 text-[10px] text-muted-foreground/70">
                {a.instructions.length.toLocaleString()} chars
              </span>
            }
          />
        ))}
      </Section>

      <Section
        label="Skills (global)"
        count={globalSkills.length}
        empty="No global skills. Project skills appear in their own project."
      >
        {globalSkills.slice(0, 12).map((s) => (
          <ItemRow
            key={s.name}
            icon={
              <HugeiconsIcon
                icon={SparklesIcon}
                size={14}
                strokeWidth={1.75}
                className={ROW_ICON}
              />
            }
            title={`#${s.handle}`}
            meta={s.mcpServers.length > 0 ? `+${s.mcpServers.length} MCP` : undefined}
          />
        ))}
        {globalSkills.length > 12 ? (
          <div className="px-1 text-[10.5px] text-muted-foreground">
            +{globalSkills.length - 12} more
          </div>
        ) : null}
      </Section>

      <Section
        label="Tool servers"
        count={mcpServers.length}
        empty="No MCP servers registered."
      >
        {mcpServers.map((s) => (
          <ItemRow
            key={s.id}
            icon={
              <HugeiconsIcon
                icon={PuzzleIcon}
                size={14}
                strokeWidth={1.75}
                className={ROW_ICON}
              />
            }
            title={s.name}
            detail={
              <span
                className={cn(
                  "shrink-0 rounded-full px-1.5 text-[10px]",
                  s.enabled
                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {s.enabled ? "enabled" : "off"}
              </span>
            }
            meta={s.transport}
          />
        ))}
      </Section>

      <Section
        label="Reminders"
        count={pendingReminders.length}
        empty="No pending reminders."
      >
        {pendingReminders.slice(0, 8).map((r) => (
          <ItemRow
            key={r.id}
            icon={
              <HugeiconsIcon
                icon={Calendar01Icon}
                size={14}
                strokeWidth={1.75}
                className={ROW_ICON}
              />
            }
            title={r.message}
            meta={relativeTime(new Date(r.dueAt).getTime())}
          />
        ))}
      </Section>

      {/* Denial / approval history: link to Security, don't duplicate it. */}
      <div className="flex flex-col gap-1.5 rounded-2xl border border-border bg-card/50 p-4">
        <GroupLabel>Approvals & denials</GroupLabel>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          What the agent wanted to do, what you approved, and what was blocked
          is recorded in the audit trail.
        </p>
        <div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2.5 text-[11px]"
            onClick={() => void openSettingsWindow("security")}
          >
            <HugeiconsIcon icon={LockKeyIcon} size={12} strokeWidth={1.75} />
            Open Security
          </Button>
        </div>
      </div>

      {/* Journal detail — the drill-down. Loaded lazily per opened session. */}
      <JournalDetailDialog row={openJournal} onClose={() => setOpenJournal(null)} />
    </div>
  );
}

function JournalDetailDialog({
  row,
  onClose,
}: {
  row: JournalRow | null;
  onClose: () => void;
}) {
  const [events, setEvents] = useState<SessionJournalEntry[] | null>(null);

  useEffect(() => {
    if (!row) {
      setEvents(null);
      return;
    }
    let live = true;
    setEvents(null);
    void sessionEventsRecent(row.info.sessionId, 200)
      .then((e) => live && setEvents(e))
      .catch(() => live && setEvents([]));
    return () => {
      live = false;
    };
  }, [row]);

  const s = row?.summary;
  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-mono text-[13px]">
            {row?.info.sessionId}
          </DialogTitle>
          <DialogDescription className="text-[11px]">
            {s
              ? `${s.turns} model turns · ${humanSize(row?.info.sizeBytes ?? 0)} · ${
                  s.models.length
                } model${s.models.length === 1 ? "" : "s"}${
                  s.lastAutoApprove && s.lastAutoApprove !== "off"
                    ? ` · last run auto:${s.lastAutoApprove}`
                    : ""
                }`
              : "Session journal"}
          </DialogDescription>
        </DialogHeader>

        {s && s.models.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {s.models.map((m) => (
              <span
                key={m}
                className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
              >
                {m}
              </span>
            ))}
          </div>
        ) : null}

        {s && (s.contextEvents > 0 || s.anomalies > 0) ? (
          <div className="flex gap-3 text-[11px]">
            {s.contextEvents > 0 ? (
              <span className="text-blue-600 dark:text-blue-400">
                {s.contextEvents} context event{s.contextEvents > 1 ? "s" : ""}
              </span>
            ) : null}
            {s.anomalies > 0 ? (
              <span className="text-amber-600 dark:text-amber-400">
                {s.anomalies} retry/loop flag{s.anomalies > 1 ? "s" : ""}
              </span>
            ) : null}
          </div>
        ) : null}

        <div className="max-h-80 overflow-y-auto rounded-lg border border-border/60">
          {events === null ? (
            <div className="py-6 text-center text-[11px] text-muted-foreground">
              Loading…
            </div>
          ) : events.length === 0 ? (
            <div className="py-6 text-center text-[11px] text-muted-foreground">
              No events in this journal.
            </div>
          ) : (
            events.map((ev, i) => {
              const style = EVENT_STYLE[ev.kind] ?? {
                label: ev.kind,
                cls: "text-muted-foreground",
              };
              return (
                <div
                  key={i}
                  className={cn(
                    "flex items-baseline gap-2.5 px-3 py-1.5 text-[11px]",
                    i > 0 && "border-t border-border/40",
                  )}
                >
                  <span className="w-14 shrink-0 font-mono text-[10px] text-muted-foreground/70">
                    {relativeTime((ev as { ts?: number }).ts)}
                  </span>
                  <span className={cn("w-16 shrink-0 font-medium", style.cls)}>
                    {style.label}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {eventLine(ev)}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
