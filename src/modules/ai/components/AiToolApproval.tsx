import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  AiBrain03Icon,
  Cancel01Icon,
  FileEditIcon,
  FilePlusIcon,
  FolderAddIcon,
  PencilEdit01Icon,
  TerminalIcon,
  Tick02Icon,
  ToolsIcon,
  UserWarning01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ToolUIPart } from "ai";
import { memo, useCallback, useState } from "react";
import { useChatStore } from "../store/chatStore";
import { abortSession, getSessionAutoApprove } from "../store/chatStore";
import { setEditedToolInput } from "../lib/toolInputOverrides";
import { predictAutoApproval } from "../lib/autoApprovePrediction";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { getToolActionInfo, analyzeShellCommand } from "../lib/policy";
import { presentationFor } from "../lib/toolPresentations";

type Props = {
  part: Extract<ToolUIPart, { state: "approval-requested" }>;
  toolName: string;
  onRespond: (approved: boolean) => void;
  /** Sequential approval queue: queued = render as a compact chip, not a card. */
  queue?: { queued: boolean; position: number; total: number } | null;
  /** PROXY MODE (group panel + Telegram): this card decides on behalf of
   *  another surface - a group persona's headless run or a background
   *  project session. Differences: a "requested by <name>" subtitle, and
   *  NO edit affordance - edited-shell approve injects into the FOREGROUND
   *  terminal, which would run the command in the wrong project; memory
   *  edit depends on the foreground session's tool execute. Deny is always
   *  available, and shell preview still renders read-only. */
  proxy?: {
    requester: string;
    /** Where the requester runs, shown in the subtitle ("persona - no project"). */
    context?: string;
  } | null;
};

// Icons only (UI-layer). Approval-card LABELS come from the toolPresentations
// registry's `approvalLabel` — the single source shared with the result card.
const TOOL_ICON: Record<string, typeof FilePlusIcon> = {
  write_file: FilePlusIcon,
  edit: FileEditIcon,
  create_directory: FolderAddIcon,
  bash_run: TerminalIcon,
  bash_background: TerminalIcon,
  save_memory: AiBrain03Icon,
};

function AiToolApprovalImpl({ part, toolName, onRespond, queue, proxy }: Props) {
  const meta = TOOL_ICON[toolName];
  const label = presentationFor(toolName).approvalLabel ?? toolName;
  const Icon = meta ?? ToolsIcon;
  const input = part.input as Record<string, unknown>;
  const autoApprovedIds = useChatStore((s) => s.autoApprovedIds);
  const wasAutoApproved = autoApprovedIds.has(part.approval.id);
  // First-frame prediction (anti-blink): in autoApprove "all" mode the
  // bridge approves this call within a tick or two of the part appearing;
  // rendering the full card for that window and then collapsing it read as
  // a blink on every tool call. predictAutoApproval MIRRORS the bridge's
  // carve-outs (elevated / privacy / signed commit) so exactly the calls
  // the bridge WILL approve render the flat row from the start. PROXY
  // cards are exempt: their sessions run behind the group panel / Telegram
  // with their own approval routing, never this window's auto-approve.
  const sessionAutoApprove = useChatStore((s) =>
    getSessionAutoApprove(s.activeSessionId ?? ""),
  );
  const signingApprovalRequired = usePreferencesStore(
    (s) => s.commitSigningEnabled && s.commitSigningMode === "approval",
  );
  const willBeAutoApproved =
    !proxy &&
    predictAutoApproval({
      autoApprove: sessionAutoApprove,
      toolName,
      input,
      signingApprovalRequired,
    });

  const isShell = toolName === "bash_run" || toolName === "bash_background";
  const isMemory = toolName === "save_memory";
  // Tools whose single text field the user can edit in the card before
  // approving. Shell edits run via terminal injection (see handleApprove);
  // memory edits travel out-of-band to the tool's execute (see
  // toolInputOverrides).
  // PROXY cards never offer edit - the injection and override paths both
  // target the FOREGROUND session, which is not the requester (see the
  // proxy prop doc).
  const isEditable = !proxy && (isShell || isMemory);
  const commandText = isShell ? String(input.command ?? "") : "";
  const entryText = isMemory ? String(input.entry ?? "") : "";
  const isElevated = toolName === "bash_run" && input.elevated === true;
  const [isEditing, setIsEditing] = useState(false);
  const [editedCommand, setEditedCommand] = useState("");

  // When entering edit mode, seed with the original command.
  const enterEdit = useCallback(() => {
    setEditedCommand(isShell ? commandText : entryText);
    setIsEditing(true);
  }, [isShell, commandText, entryText]);

  const cancelEdit = useCallback(() => {
    setIsEditing(false);
    setEditedCommand("");
  }, []);

  const handleApprove = useCallback(() => {
    if (isMemory && isEditing) {
      // Register the edited entry; the tool consumes it at execute time via
      // its toolCallId (the SDK approval response cannot carry new input).
      setEditedToolInput(part.toolCallId, { entry: editedCommand });
      onRespond(true);
      return;
    }
    if (isShell && isEditing && editedCommand !== commandText) {
      // Deny the original tool call and inject the edited command directly
      // into the active terminal — no agent round-trip.
      onRespond(false);
      const live = useChatStore.getState().live;
      live.injectIntoActivePty(editedCommand + "\r");
      // Abort the agent so it can't re-issue the original (unedited)
      // command. This is the ONLY place abortSession is called on
      // denial — normal Deny lets the agent see the rejection and
      // continue gracefully.
      const sessionId = useChatStore.getState().activeSessionId;
      if (sessionId) abortSession(sessionId);
    } else {
      onRespond(true);
    }
  }, [isMemory, isShell, isEditing, editedCommand, commandText, part.toolCallId, onRespond]);

  // Flat one-row state — rendered from the FIRST frame when the bridge is
  // guaranteed to auto-approve (prediction), and on the approval-responded
  // transition (wasAutoApproved) for the rest. Must be checked BEFORE the
  // queue branch: in "all" mode every position renders flat, never a chip.
  // NO border/box: the Tool row that replaces this card on the
  // approval-responded transition has no border and uses px-2 py-1.5 — a
  // bordered box here made the whole row visibly jump when the state
  // flipped. Match the Tool row geometry so the swap is dot-color only.
  if (wasAutoApproved || willBeAutoApproved) {
    return (
      <div className="flex w-full items-center gap-2 rounded-md px-2 py-1.5">
          {/* Dot language, matching the tool cards — a green check-circle
              icon here flashed between the approval and execution states
              and read as a glitch. */}
          <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
          <HugeiconsIcon
            icon={Icon}
            size={13}
            strokeWidth={1.75}
            className="shrink-0 text-muted-foreground"
          />
          <span className="text-[12px] font-medium text-foreground">
            {label}
          </span>
          <span className="ml-auto text-[10px] text-emerald-600 dark:text-emerald-400">
            auto-approved
          </span>
      </div>
    );
  }

  // Queued behind an earlier approval — compact placeholder, no actions.
  // (Manual mode only in practice: auto-approved positions render flat above.)
  if (queue?.queued) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-dashed border-border/60 bg-muted/30 px-3 py-1.5 opacity-70">
        <HugeiconsIcon
          icon={Icon}
          size={12}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="text-[11px] text-muted-foreground">
          {label}
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground/80">
          queued {queue.position} of {queue.total}
        </span>
      </div>
    );
  }

  // Get policy info for this tool
  const policyInfo = getToolActionInfo(toolName);

  // Analyze shell commands for additional warnings
  const shellAnalysis = toolName === "bash_run" && typeof input.command === "string"
    ? analyzeShellCommand(input.command)
    : null;

  // Elevation is a stronger trust boundary than a normal bash_run approval.
  const elevatedInfo = isElevated
    ? { riskLevel: "critical" as const, description: "Administrator/root privileges — OS prompt will appear" }
    : null;

  return (
    <div className="rounded-lg border border-border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <span className="size-1.5 shrink-0 rounded-full bg-amber-500 animate-pulse" />
        <HugeiconsIcon
          icon={Icon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="text-[12px] font-medium text-foreground">
          {label}
        </span>
        {proxy ? (
          <span className="min-w-0 truncate text-[10px] text-muted-foreground">
            requested by <span className="font-medium text-foreground/80">{proxy.requester}</span>
            {proxy.context ? <span className="opacity-70"> ({proxy.context})</span> : null}
          </span>
        ) : null}
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
          {queue && queue.total > 1
            ? `needs approval · ${queue.position} of ${queue.total}`
            : "needs approval"}
        </span>
      </div>

      <div className="px-3 py-2.5">
        {/* Elevated-privilege banner — hard to miss, distinct from the normal card. */}
        {isElevated && (
          <div className="mb-2.5 flex items-start gap-2 rounded-md border border-red-500/40 bg-red-50 px-2.5 py-2 dark:bg-red-950/20">
            <HugeiconsIcon
              icon={UserWarning01Icon}
              size={15}
              strokeWidth={2}
              className="mt-0.5 shrink-0 text-red-600 dark:text-red-400"
            />
            <div className="flex-1">
              <p className="text-[11px] font-semibold text-red-700 dark:text-red-300">
                Elevated privileges requested
              </p>
              <p className="mt-0.5 text-[10px] leading-relaxed text-red-600 dark:text-red-400">
                This command runs with administrator/root rights. An OS
                permission prompt will appear. Approving here grants the agent
                system-level access — only continue if you trust the command.
              </p>
            </div>
          </div>
        )}

        <PreviewBlock
          toolName={toolName}
          input={input}
          editing={isEditing}
          editedValue={editedCommand}
          onEditChange={setEditedCommand}
        />

        {/* Policy risk level and warnings */}
        {(policyInfo.riskLevel !== "low" || shellAnalysis?.warnings.length) && (
          <div className="mt-3 space-y-2">
            {/* Risk level badge */}
            <div className="flex items-center gap-2">
              <Badge
                variant="secondary"
                className={cn(
                  "text-[10px] font-medium",
                  (elevatedInfo?.riskLevel ?? policyInfo.riskLevel) === "critical" && "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
                  (elevatedInfo?.riskLevel ?? policyInfo.riskLevel) === "high" && "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
                  (elevatedInfo?.riskLevel ?? policyInfo.riskLevel) === "medium" && "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
                )}
              >
                {(elevatedInfo?.riskLevel ?? policyInfo.riskLevel) === "critical" && "⚠️ Critical Risk"}
                {(elevatedInfo?.riskLevel ?? policyInfo.riskLevel) === "high" && "⚠️ High Risk"}
                {(elevatedInfo?.riskLevel ?? policyInfo.riskLevel) === "medium" && "Medium Risk"}
              </Badge>
              <span className="text-[11px] text-muted-foreground">
                {elevatedInfo?.description ?? policyInfo.description}
              </span>
            </div>

            {/* Shell command warnings */}
            {shellAnalysis?.warnings.length ? (
              <div className="rounded-md bg-amber-50 dark:bg-amber-950/20 p-2">
                <div className="flex items-start gap-1.5">
                  <HugeiconsIcon
                    icon={UserWarning01Icon}
                    size={14}
                    strokeWidth={2}
                    className="text-amber-600 dark:text-amber-400 mt-0.5"
                  />
                  <div className="flex-1">
                    <p className="text-[11px] font-medium text-amber-800 dark:text-amber-300">
                      Warnings:
                    </p>
                    <ul className="mt-1 space-y-0.5">
                      {shellAnalysis.warnings.map((warning, i) => (
                        <li key={i} className="text-[10px] text-amber-700 dark:text-amber-400">
                          • {warning}
                        </li>
                      ))}
                    </ul>
                    {shellAnalysis.suggestions.length > 0 && (
                      <p className="mt-2 text-[10px] text-amber-700 dark:text-amber-400">
                        <strong>Suggestion:</strong> {shellAnalysis.suggestions[0]}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-1.5 border-t border-border/60 px-3 py-2">
        {isEditing ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={cancelEdit}
              className="h-7 gap-1.5 text-[11px]"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
              Cancel
            </Button>
            <Button
              size="sm"
              variant="default"
              onClick={handleApprove}
              className="h-7 gap-1.5 text-[11px]"
            >
              <HugeiconsIcon icon={Tick02Icon} size={12} strokeWidth={2} />
              {isMemory ? "Save edited" : "Run edited"}
            </Button>
          </>
        ) : (
          <>
            {isEditable && (
              <Button
                size="icon"
                variant="ghost"
                onClick={enterEdit}
                className="mr-auto size-7"
                aria-label="Edit command"
                title="Edit command"
              >
                <HugeiconsIcon
                  icon={PencilEdit01Icon}
                  size={13}
                  strokeWidth={1.75}
                />
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onRespond(false)}
              className="h-7 gap-1.5 text-[11px]"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
              Deny
            </Button>
            <Button
              size="sm"
              variant={isElevated ? "destructive" : "default"}
              onClick={() => onRespond(true)}
              className="h-7 gap-1.5 text-[11px]"
            >
              <HugeiconsIcon icon={Tick02Icon} size={12} strokeWidth={2} />
              {isElevated ? "Approve elevation" : "Approve"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export const AiToolApproval = memo(AiToolApprovalImpl, (a, b) => {
  // The approval card never changes content for a given approvalId — once
  // the model has emitted the approval-requested part with its input, we
  // don't want to re-render on every downstream token. Deliberately omit
  // onRespond: the closure captures the stable approval.id and streaming
  // re-renders cause rapid function-identity churn that makes earlier
  // approval cards unresponsive to clicks.
  return (
    a.toolName === b.toolName &&
    a.part.approval.id === b.part.approval.id &&
    a.queue?.queued === b.queue?.queued &&
    a.queue?.position === b.queue?.position &&
    a.queue?.total === b.queue?.total
  );
});

function PreviewBlock({
  toolName,
  input,
  editing,
  editedValue,
  onEditChange,
}: {
  toolName: string;
  input: Record<string, unknown>;
  editing?: boolean;
  editedValue?: string;
  onEditChange?: (v: string) => void;
}) {
  if (toolName === "bash_run" || toolName === "bash_background") {
    const cwd = typeof input.cwd === "string" ? input.cwd : null;
    const command = String(input.command ?? "");
    return (
      <div className="space-y-1.5">
        {cwd && (
          <div className="font-mono text-[10.5px] text-muted-foreground">
            {cwd}
          </div>
        )}
        {editing ? (
          <textarea
            value={editedValue ?? command}
            onChange={(e) => onEditChange?.(e.target.value)}
            className={cn(
              "w-full rounded-md border border-border bg-card p-2 font-mono text-[11px] leading-relaxed",
              "resize-none outline-none focus:border-amber-500/50 focus:ring-1 focus:ring-amber-500/30",
            )}
            rows={Math.min((editedValue ?? command).split("\n").length, 8)}
            spellCheck={false}
            autoFocus
          />
        ) : (
          <pre
            className={cn(
              "max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-relaxed",
            )}
          >
            {command}
          </pre>
        )}
      </div>
    );
  }
  if (toolName === "save_memory") {
    const entry = String(input.entry ?? "");
    return (
      <div className="space-y-1.5">
        <div className="text-[10.5px] text-muted-foreground">
          Persistent project memory — loaded into every future session
        </div>
        {editing ? (
          <textarea
            value={editedValue ?? entry}
            onChange={(e) => onEditChange?.(e.target.value)}
            className={cn(
              "w-full rounded-md border border-border bg-card p-2 text-[11px] leading-relaxed",
              "resize-none outline-none focus:border-amber-500/50 focus:ring-1 focus:ring-amber-500/30",
            )}
            rows={Math.min((editedValue ?? entry).split("\n").length + 1, 14)}
            spellCheck={false}
            autoFocus
          />
        ) : (
          <pre
            className={cn(
              "max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 p-2 text-[11px] leading-relaxed",
            )}
          >
            {entry}
          </pre>
        )}
      </div>
    );
  }
  // For file mutations we deliberately do NOT preview content here —
  // streamed write/edit content thrashes the UI and the AI diff tab is the
  // authoritative place to review the change. Show just the path + a
  // one-line size hint so the user knows what's being touched.
  if (toolName === "write_file") {
    const content = typeof input.content === "string" ? input.content : "";
    const lines = content ? content.split("\n").length : 0;
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="text-muted-foreground">{String(input.path ?? "")}</div>
        <div className="text-[10.5px] text-muted-foreground/80">
          {lines} line{lines === 1 ? "" : "s"} · review in the diff tab
        </div>
      </div>
    );
  }
  if (toolName === "edit") {
    const oldStr = typeof input.old_string === "string" ? input.old_string : "";
    const newStr = typeof input.new_string === "string" ? input.new_string : "";
    const removed = oldStr ? oldStr.split("\n").length : 0;
    const added = newStr ? newStr.split("\n").length : 0;
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="text-muted-foreground">
          {String(input.path ?? "")}
          {input.replace_all ? " · replace all" : ""}
        </div>
        <div className="text-[10.5px] text-muted-foreground/80">
          −{removed} / +{added} line{added === 1 && removed === 1 ? "" : "s"} ·
          review in the diff tab
        </div>
      </div>
    );
  }
  if (toolName === "batch_edit") {
    const edits = Array.isArray(input.edits)
      ? (input.edits as Array<{ path?: string }>)
      : [];
    const files = new Set(
      edits.map((e) => e.path).filter((p): p is string => !!p),
    );
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        {Array.from(files)
          .slice(0, 3)
          .map((p) => (
            <div key={p} className="text-muted-foreground">
              {p}
            </div>
          ))}
        <div className="text-[10.5px] text-muted-foreground/80">
          {edits.length} edit{edits.length === 1 ? "" : "s"} in {files.size} file
          {files.size === 1 ? "" : "s"}
          {files.size > 3 ? ` (+${files.size - 3} more)` : ""} · review in the
          diff tab
        </div>
      </div>
    );
  }
  if (toolName === "create_directory") {
    return (
      <div className="font-mono text-[11px] text-muted-foreground">
        {String(input.path ?? "")}
      </div>
    );
  }
  if (toolName === "mcp_add_server") {
    const transport = String(input.transport ?? "stdio");
    const env = (input.env ?? {}) as Record<string, string>;
    const envKeys = Object.keys(env);
    return (
      <div className="space-y-1 font-mono text-[11px]">
        <div className="text-foreground">
          {String(input.name ?? "")}{" "}
          <span className="text-muted-foreground">· {transport}</span>
        </div>
        <div className="break-all text-muted-foreground">
          {transport === "stdio"
            ? [input.command, ...(Array.isArray(input.args) ? input.args : [])]
                .filter(Boolean)
                .join(" ")
            : String(input.url ?? "")}
        </div>
        {envKeys.length > 0 && (
          <div className="text-[10.5px] text-muted-foreground/80">
            env: {envKeys.join(", ")}
          </div>
        )}
      </div>
    );
  }
  return (
    <pre className="overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-relaxed">
      {JSON.stringify(input, null, 2)}
    </pre>
  );
}

