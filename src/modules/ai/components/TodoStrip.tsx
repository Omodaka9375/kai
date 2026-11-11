import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon";
import CheckmarkSquare02Icon from "@hugeicons/core-free-icons/CheckmarkSquare02Icon";
import SquareIcon from "@hugeicons/core-free-icons/SquareIcon";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Todo } from "../lib/todos";
import { useTodosStore } from "../store/todoStore";
import {
  getSessionAutoApprove,
  getSessionAutoApproveVersion,
  subscribeSessionAutoApprove,
} from "../store/chatStore";

type Props = {
  sessionId: string | null;
  isBusy?: boolean;
  onStop?: () => void;
};

/** The stop-agent control: a small BLINKING SQUARE (2026-11-04 user
 *  report: "stop agent button is a circle and doesn't look like anything is
 *  working"). The old muted StopCircleIcon glyph read as nothing at 4px; a
 *  blinking square says "recording/running - press to stop" at a
 *  glance, the same convention recorders use.
 *
 *  COLOR (2026-11-06 ask): the square matches the permission indicator's
 *  CURRENT color - the same emerald/amber the Allow/Ask toggle dot shows.
 *  Green = the agent runs under auto-allow, yellow = it runs in Ask mode;
 *  one color language across the whole agent-control cluster (toggle dot,
 *  this square). */
function StopSquare({
  onClick,
  stopPropagation,
  mode,
}: {
  onClick: () => void;
  stopPropagation?: boolean;
  mode: "off" | "all";
}) {
  const allowMode = mode === "all";
  return (
    <button
      type="button"
      onClick={(e) => {
        if (stopPropagation) e.stopPropagation();
        onClick();
      }}
      className={cn(
        "size-2 shrink-0 cursor-pointer rounded-full animate-pulse transition-transform hover:scale-125 hover:animate-none",
        allowMode
          ? "bg-emerald-500 shadow-[0_0_0_2px] shadow-emerald-500/20"
          : "bg-amber-500 shadow-[0_0_0_2px] shadow-amber-500/20",
      )}
      title="Stop agent"
      aria-label="Stop agent"
    />
  );
}

const EMPTY_TODOS: Todo[] = [];

export function TodoStrip({ sessionId, isBusy, onStop }: Props) {
  const hydrate = useTodosStore((s) => s.hydrate);
  const todos =
    useTodosStore((s) => (sessionId ? s.bySession[sessionId] : undefined)) ??
    EMPTY_TODOS;
  const [expanded, setExpanded] = useState(true);
  // Session-scoped auto-approve mode for the Stop square's color (see
  // StopSquare). Same reactive pattern as the bridge: the Map read is not
  // reactive, so subscribe to the version counter bumped on every toggle.
  const autoApproveVersion = useSyncExternalStore(
    subscribeSessionAutoApprove,
    getSessionAutoApproveVersion,
    getSessionAutoApproveVersion,
  );
  const approveMode = useMemo(
    () => getSessionAutoApprove(sessionId ?? ""),
    [sessionId, autoApproveVersion],
  );

  // Auto-collapse when list grows past 5 items
  const count = todos.length;
  useEffect(() => {
    if (count > 5) setExpanded(false);
  }, [count]);

  const clearSession = useTodosStore((s) => s.clearSession);

  useEffect(() => {
    if (sessionId) void hydrate(sessionId);
  }, [sessionId, hydrate]);

  // Auto-close and remove todo list when all items are completed
  useEffect(() => {
    if (!sessionId || todos.length === 0) return;
    const allCompleted = todos.every((t) => t.status === "completed");
    if (allCompleted) {
      void clearSession(sessionId);
    }
  }, [todos, sessionId, clearSession]);

  if (!sessionId || (todos.length === 0 && !isBusy)) return null;

  if (todos.length === 0) {
    return (
      <div className="flex shrink-0 items-center justify-between border-t border-border/80 bg-muted/20 px-3 py-1.5 h-8">
        <span className="text-[11px] text-muted-foreground flex items-center gap-1.5">
          <Spinner className="size-3" />
          <span>Agent running…</span>
        </span>
        <StopSquare onClick={() => onStop?.()} mode={approveMode} />
      </div>
    );
  }

  const completed = todos.filter((t) => t.status === "completed").length;
  const pct = Math.round((completed / todos.length) * 100);

  const toggleTodo = (todoId: string) => {
    if (!sessionId) return;
    const nextTodos = todos.map((t) =>
      t.id === todoId
        ? {
            ...t,
            status: t.status === "completed" ? "pending" as const : "completed" as const,
          }
        : t,
    );
    useTodosStore.getState().setTodos(sessionId, nextTodos);
  };

  return (
    <div className="shrink-0 border-t border-border/80 bg-muted/20 px-3 py-1.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="my-1 flex w-full cursor-pointer items-center gap-2"
      >
        <HugeiconsIcon
          icon={expanded ? ArrowDown01Icon : ArrowRight01Icon}
          size={10}
          strokeWidth={2}
          className="shrink-0 text-muted-foreground"
        />
        <span className="text-[11px] font-medium text-foreground">Todos</span>
        <Progress value={pct} className="h-1 flex-1" />
        <span className="text-[11px] tabular-nums font-mono text-muted-foreground">
          {completed}/{todos.length}
        </span>
        {isBusy && (
          <StopSquare onClick={() => onStop?.()} stopPropagation mode={approveMode} />
        )}
      </button>
      {expanded && (
        <ul className="flex flex-col gap-0.5">
          {todos.map((t) => (
            <TodoRow key={t.id} todo={t} onToggle={() => toggleTodo(t.id)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function TodoRow({ todo, onToggle }: { todo: Todo; onToggle: () => void }) {
  const isInProgress = todo.status === "in_progress";
  const row = (
    <li
      onClick={onToggle}
      className={cn(
        "flex items-start gap-2 rounded px-1.5 py-1 text-[11px] leading-snug cursor-pointer hover:bg-muted/40 transition-colors",
        isInProgress && "border-l-2 border-foreground/50 bg-muted/40",
      )}
    >
      <span className="mt-[2px] inline-flex size-3.5 shrink-0 items-center justify-center">
        {isInProgress ? (
          <Spinner className="size-3" />
        ) : (
          <HugeiconsIcon
            icon={
              todo.status === "completed" ? CheckmarkSquare02Icon : SquareIcon
            }
            strokeWidth={1.75}
          />
        )}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1",
          todo.status === "completed"
            ? "text-muted-foreground/60 line-through"
            : isInProgress
              ? "text-foreground"
              : "text-muted-foreground",
        )}
      >
        {todo.title}
      </span>
    </li>
  );

  if (!todo.description) return row;
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{row}</TooltipTrigger>
        <TooltipContent side="left" className="max-w-xs text-[11px]">
          {todo.description}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
