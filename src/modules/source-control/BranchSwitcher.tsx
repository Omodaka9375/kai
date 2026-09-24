import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { native, type GitBranch } from "@/modules/ai/lib/native";
import {
  CheckmarkCircle01Icon,
  Delete01Icon,
  GitBranchIcon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

type Props = {
  repoRoot: string;
  currentBranch: string;
  isDetached: boolean;
  /** Called after a branch mutation so the panel re-reads status/branch. */
  onChanged: () => Promise<void>;
};

/**
 * Branch picker for the source-control header. Lists local branches (current
 * branch marked), lets the user switch with a single click, and create / delete
 * branches without leaving the panel. Every mutation round-trips through the
 * Rust git module (no raw shell), then refreshes the panel.
 */
export function BranchSwitcher({
  repoRoot,
  currentBranch,
  isDetached,
  onChanged,
}: Props) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const list = await native.gitListBranches(repoRoot);
      if (requestId !== requestIdRef.current) return;
      setBranches(list);
    } catch (e) {
      if (requestId !== requestIdRef.current) return;
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [repoRoot]);

  // Reload whenever the popover opens or the repo root changes.
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // Focus the create input when entering create mode.
  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  const current = useMemo(
    () => branches.find((b) => b.current)?.name ?? currentBranch,
    [branches, currentBranch],
  );

  const switchTo = useCallback(
    async (name: string) => {
      setBusy(`switch:${name}`);
      setError(null);
      try {
        await native.gitSwitchBranch(repoRoot, name);
        setOpen(false);
        await onChanged();
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e));
        void load();
      } finally {
        setBusy(null);
      }
    },
    [repoRoot, onChanged, load],
  );

  const createBranch = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy("create");
    setError(null);
    try {
      await native.gitCreateBranch(repoRoot, name);
      setNewName("");
      setCreating(false);
      await onChanged();
      setOpen(false);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
    }
  }, [newName, repoRoot, onChanged]);

  const deleteBranch = useCallback(
    async (name: string) => {
      setBusy(`delete:${name}`);
      setError(null);
      try {
        await native.gitDeleteBranch(repoRoot, name);
        await onChanged();
        await load();
        setPendingDelete(null);
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e));
      } finally {
        setBusy(null);
      }
    },
    [repoRoot, onChanged, load],
  );

  const handleCreateKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void createBranch();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setCreating(false);
      setNewName("");
    }
  };

  const label = isDetached ? "(detached)" : current;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Switch branch"
          className={cn(
            "inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md bg-foreground/5 px-2 py-1 text-[11.5px] font-medium leading-none text-foreground transition-colors hover:bg-foreground/10",
          )}
        >
          <HugeiconsIcon
            icon={GitBranchIcon}
            size={12}
            strokeWidth={1.9}
            className="shrink-0 text-muted-foreground"
          />
          <span className="max-w-[140px] truncate">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-72 gap-0 rounded-xl p-1.5 text-foreground"
      >
        <div className="px-2 pb-1.5 pt-1 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Branches
        </div>

        <div className="max-h-[260px] overflow-y-auto">
          {loading && branches.length === 0 ? (
            <div className="px-2 py-2 text-[11px] text-muted-foreground">
              Loading…
            </div>
          ) : branches.length === 0 ? (
            <div className="px-2 py-2 text-[11px] text-muted-foreground">
              No local branches.
            </div>
          ) : (
            branches.map((b) => {
              const isCurrent = b.current;
              return (
                <div
                  key={b.name}
                  className={cn(
                    "group flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px]",
                    isCurrent ? "bg-foreground/8" : "hover:bg-foreground/5",
                  )}
                >
                  <button
                    type="button"
                    disabled={isCurrent || busy !== null}
                    onClick={() => void switchTo(b.name)}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left disabled:cursor-default"
                  >
                    <HugeiconsIcon
                      icon={isCurrent ? CheckmarkCircle01Icon : GitBranchIcon}
                      size={13}
                      strokeWidth={1.9}
                      className={cn(
                        "shrink-0",
                        isCurrent
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-muted-foreground",
                      )}
                    />
                    <span className="truncate font-mono text-[12px]">
                      {b.name}
                    </span>
                  </button>
                  {!isCurrent && pendingDelete !== b.name ? (
                    <button
                      type="button"
                      title={`Delete ${b.name}`}
                      disabled={busy !== null}
                      onClick={() => setPendingDelete(b.name)}
                      className="hidden size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-destructive/15 hover:text-destructive group-hover:inline-flex"
                    >
                      <HugeiconsIcon
                        icon={Delete01Icon}
                        size={12}
                        strokeWidth={1.9}
                      />
                    </button>
                  ) : null}
                  {!isCurrent && pendingDelete === b.name ? (
                    <span className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        title="Confirm delete"
                        disabled={busy !== null}
                        onClick={() => void deleteBranch(b.name)}
                        className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md bg-destructive/15 text-destructive hover:bg-destructive/25"
                      >
                        <HugeiconsIcon
                          icon={Delete01Icon}
                          size={11}
                          strokeWidth={2.1}
                        />
                      </button>
                      <button
                        type="button"
                        title="Cancel"
                        disabled={busy !== null}
                        onClick={() => setPendingDelete(null)}
                        className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/70 hover:bg-foreground/10 hover:text-foreground"
                      >
                        <HugeiconsIcon
                          icon={PlusSignIcon}
                          size={11}
                          strokeWidth={2.1}
                          className="rotate-45"
                        />
                      </button>
                    </span>
                  ) : null}
                </div>
              );
            })
          )}
        </div>

        {error ? (
          <div className="mx-1 mt-1 rounded-md border border-destructive/25 bg-destructive/[0.07] px-2 py-1.5 text-[10.5px] leading-snug text-destructive dark:text-red-300">
            {error}
          </div>
        ) : null}

        {creating ? (
          <div className="mt-1.5 flex items-center gap-1.5 border-t border-border/50 px-1 pt-1.5">
            <Input
              ref={inputRef}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={handleCreateKeyDown}
              placeholder="branch-name"
              className="h-7 flex-1 text-[12px]"
              disabled={busy !== null}
            />
            <Button
              size="xs"
              className="h-7 shrink-0 cursor-pointer"
              disabled={busy !== null || newName.trim().length === 0}
              onClick={() => void createBranch()}
            >
              Create
            </Button>
          </div>
        ) : (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => setCreating(true)}
            className="mt-1.5 flex cursor-pointer items-center gap-1.5 rounded-md border-t border-border/50 px-2 py-2 text-[11.5px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <HugeiconsIcon
              icon={PlusSignIcon}
              size={13}
              strokeWidth={2}
              className="shrink-0"
            />
            New branch
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}