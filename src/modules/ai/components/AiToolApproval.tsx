import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Edit02Icon,
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
import { abortSession } from "../store/chatStore";
import { getToolActionInfo, analyzeShellCommand } from "../lib/policy";

type Props = {
  part: Extract<ToolUIPart, { state: "approval-requested" }>;
  toolName: string;
  onRespond: (approved: boolean) => void;
  /** Sequential approval queue: queued = render as a compact chip, not a card. */
  queue?: { queued: boolean; position: number; total: number } | null;
};

const TOOL_META: Record<string, { label: string; icon: typeof FilePlusIcon }> =
  {
    write_file: { label: "Write file", icon: FilePlusIcon },
    edit: { label: "Edit file", icon: FileEditIcon },
    multi_edit: { label: "Edit file (batch)", icon: Edit02Icon },
    create_directory: { label: "Create directory", icon: FolderAddIcon },
    bash_run: { label: "Run shell command", icon: TerminalIcon },
    bash_background: { label: "Spawn background process", icon: TerminalIcon },
  };

function AiToolApprovalImpl({ part, toolName, onRespond, queue }: Props) {
  const meta = TOOL_META[toolName];
  const label = meta?.label ?? toolName;
  const Icon = meta?.icon ?? ToolsIcon;
  const input = part.input as Record<string, unknown>;
  const autoApprovedIds = useChatStore((s) => s.autoApprovedIds);
  const wasAutoApproved = autoApprovedIds.has(part.approval.id);

  const isShell = toolName === "bash_run" || toolName === "bash_background";
  const commandText = isShell ? String(input.command ?? "") : "";
  const [isEditing, setIsEditing] = useState(false);
  const [editedCommand, setEditedCommand] = useState("");

  // When entering edit mode, seed with the original command.
  const enterEdit = useCallback(() => {
    setEditedCommand(commandText);
    setIsEditing(true);
  }, [commandText]);

  const cancelEdit = useCallback(() => {
    setIsEditing(false);
    setEditedCommand("");
  }, []);

  const handleApprove = useCallback(() => {
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
  }, [isShell, isEditing, editedCommand, commandText, onRespond]);

  // Queued behind an earlier approval — compact placeholder, no actions.
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

  if (wasAutoApproved) {
    return (
      <div className="rounded-lg border border-border/40 bg-card/60">
        <div className="flex items-center gap-2 px-3 py-2">
          <HugeiconsIcon
            icon={CheckmarkCircle02Icon}
            size={13}
            strokeWidth={1.75}
            className="shrink-0 text-emerald-500"
          />
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
      </div>
    );
  }

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
        <span className="ml-auto text-[10px] text-muted-foreground">
          {queue && queue.total > 1
            ? `needs approval · ${queue.position} of ${queue.total}`
            : "needs approval"}
        </span>
      </div>

      <div className="px-3 py-2.5">
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
                  policyInfo.riskLevel === "critical" && "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
                  policyInfo.riskLevel === "high" && "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
                  policyInfo.riskLevel === "medium" && "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
                )}
              >
                {policyInfo.riskLevel === "critical" && "⚠️ Critical Risk"}
                {policyInfo.riskLevel === "high" && "⚠️ High Risk"}
                {policyInfo.riskLevel === "medium" && "Medium Risk"}
              </Badge>
              <span className="text-[11px] text-muted-foreground">
                {policyInfo.description}
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
              Run edited
            </Button>
          </>
        ) : (
          <>
            {isShell && (
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
              variant="default"
              onClick={() => onRespond(true)}
              className="h-7 gap-1.5 text-[11px]"
            >
              <HugeiconsIcon icon={Tick02Icon} size={12} strokeWidth={2} />
              Approve
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
  if (toolName === "multi_edit") {
    const edits = Array.isArray(input.edits)
      ? (input.edits as Array<{ old_string?: string; new_string?: string }>)
      : [];
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="text-muted-foreground">{String(input.path ?? "")}</div>
        <div className="text-[10.5px] text-muted-foreground/80">
          {edits.length} edit{edits.length === 1 ? "" : "s"} · review in the
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
  return (
    <pre className="overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-relaxed">
      {JSON.stringify(input, null, 2)}
    </pre>
  );
}

