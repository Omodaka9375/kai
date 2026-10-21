import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { newMcpServerId, type McpServerConfig } from "@/modules/ai/lib/mcp";
import {
  fetchRegistryServers,
  type McpRegistryEntry,
  type McpRegistryPackage,
} from "@/modules/ai/lib/mcpRegistry";
import { useMcpStore } from "@/modules/ai/store/mcpStore";
import { McpInstallDialog } from "./McpInstallDialog";
import {
  ArrowDown01Icon,
  CheckmarkCircle02Icon,
  Download01Icon,
  PuzzleIcon,
  Search01Icon,
  WifiConnected01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useRef, useState } from "react";

export function ExtensionsView() {
  /** Raw input value — committed to `query` on Enter (search-on-Enter). */
  const [search, setSearch] = useState("");
  /** The query the visible results belong to. Changes ONLY on Enter/Escape. */
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<McpRegistryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  /** Monotonic fetch id — a stale (out-of-order) response is dropped. */
  const requestIdRef = useRef(0);
  const installedServers = useMcpStore((s) => s.servers);
  const addServer = useMcpStore((s) => s.addServer);
  const hydrate = useMcpStore((s) => s.hydrate);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const doFetch = useCallback(
    async (q: string, nextCursor?: string) => {
      // Pagination appends; a fresh query replaces. Only the newest request
      // may commit either way — a slow older response landing late must
      // never overwrite a newer one.
      const id = (requestIdRef.current += 1);
      const isPaged = nextCursor !== undefined;
      setLoading(true);
      setError(null);
      try {
        const resp = await fetchRegistryServers({
          search: q || undefined,
          cursor: nextCursor,
        });
        if (id !== requestIdRef.current) return;
        if (isPaged) {
          setEntries((prev) => [...prev, ...resp.servers]);
        } else {
          setEntries(resp.servers);
        }
        setCursor(resp.metadata.nextCursor);
        setHasMore(
          resp.metadata.nextCursor !== null && resp.servers.length > 0,
        );
      } catch (e) {
        if (id !== requestIdRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (id === requestIdRef.current) setLoading(false);
      }
    },
    [],
  );

  // One effect drives ALL fetches: `query` starts empty (initial full
  // list) and changes ONLY when the user commits with Enter (or resets with
  // Escape). No as-you-type debounce — typing never fires a request.
  useEffect(() => {
    void doFetch(query);
  }, [query, doFetch]);

  const commitSearch = () => {
    const next = search.trim();
    if (next === query) return;
    setQuery(next);
  };

  const resetSearch = () => {
    setSearch("");
    if (query !== "") setQuery("");
  };

  const loadMore = () => {
    if (cursor && !loading) void doFetch(query, cursor);
  };

  const isInstalled = (s: McpRegistryEntry["server"]) => {
    const targetName = s.title || displayName(s.name);
    return installedServers.some(
      (installed) =>
        installed.name === s.name ||
        installed.name === targetName ||
        installed.name === displayName(s.name),
    );
  };

  // Pending install: a registry entry whose package declares environment
  // variables (API tokens etc.) — the dialog collects them before addServer.
  const [pendingInstall, setPendingInstall] = useState<{
    pkg: McpRegistryPackage | null;
    config: McpServerConfig;
  } | null>(null);

  const install = (entry: McpRegistryEntry) => {
    const config = registryEntryToConfig(entry.server);
    if (!config) return;
    const pkg = entry.server.packages?.find(
      (p) => p.transport.type === config.transport || p.transport.type === "stdio",
    );
    const hasEnv = (pkg?.environmentVariables?.length ?? 0) > 0;
    if (hasEnv) {
      setPendingInstall({ pkg: pkg ?? null, config });
    } else {
      addServer(config);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center border-b border-border/60 px-3">
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          MCP Registry
        </span>
      </div>
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border/60 px-2">
        {loading ? (
          <Spinner className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <HugeiconsIcon
            icon={Search01Icon}
            size={13}
            strokeWidth={1.75}
            className="shrink-0 text-muted-foreground/70"
          />
        )}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitSearch();
            } else if (e.key === "Escape") {
              e.preventDefault();
              resetSearch();
            }
          }}
          placeholder="Search MCP servers (Enter)"
          spellCheck={false}
          className="w-full bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/50"
        />
        {/* Dirty state: typed but not committed — hint that Enter applies. */}
        {search.trim() !== query && (
          <kbd className="shrink-0 rounded border border-border/60 bg-muted/40 px-1 font-mono text-[9px] leading-4 text-muted-foreground">
            ↵
          </kbd>
        )}
      </div>

      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto transition-opacity",
          loading && "pointer-events-none opacity-50",
        )}
      >
        {error && (
          <div className="px-3 py-4 text-center text-[11px] text-destructive">
            {error}
          </div>
        )}

        {entries.length === 0 && !error && (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
            {loading ? (
              <Spinner className="size-4 text-muted-foreground/70" />
            ) : (
              <HugeiconsIcon
                icon={PuzzleIcon}
                size={20}
                strokeWidth={1.5}
                className="text-muted-foreground/60"
              />
            )}
            <span className="text-[11px] text-muted-foreground">
              {loading
                ? query
                  ? "Searching…"
                  : "Loading registry…"
                : query
                  ? `No servers found for “${query}”.`
                  : "No servers available."}
            </span>
          </div>
        )}

        <ul className="flex flex-col">
          {entries.map((entry) => {
            const s = entry.server;
            const installed = isInstalled(s);
            const hasStdio = s.packages?.some(
              (p) => p.transport.type === "stdio",
            );
            const hasRemote = (s.remotes?.length ?? 0) > 0;
            const transport = hasStdio
              ? "stdio"
              : hasRemote
                ? "remote"
                : "unknown";
            return (
              <li
                key={s.name}
                className="flex items-start gap-2 border-b border-border/30 px-3 py-2.5"
              >
                <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/40 text-muted-foreground">
                  <HugeiconsIcon
                    icon={WifiConnected01Icon}
                    size={14}
                    strokeWidth={1.5}
                  />
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[12px] font-medium text-foreground">
                      {s.title || displayName(s.name)}
                    </span>
                    <span className="shrink-0 rounded bg-muted/50 px-1 py-0.5 text-[9px] text-muted-foreground">
                      {transport}
                    </span>
                    <span className="shrink-0 text-[9px] text-muted-foreground/70">
                      v{s.version}
                    </span>
                  </div>
                  {s.description && (
                    <span className="line-clamp-2 text-[10.5px] leading-relaxed text-muted-foreground">
                      {s.description}
                    </span>
                  )}
                </div>
                <div className="shrink-0 pt-0.5">
                  {installed ? (
                    <span className="flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
                      <HugeiconsIcon
                        icon={CheckmarkCircle02Icon}
                        size={12}
                        strokeWidth={2}
                      />
                      Installed
                    </span>
                  ) : (
                    <Button
                      size="xs"
                      variant="outline"
                      className="h-6 gap-1 px-2 text-[10px]"
                      onClick={() => install(entry)}
                    >
                      <HugeiconsIcon
                        icon={Download01Icon}
                        size={11}
                        strokeWidth={2}
                      />
                      Install
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        {hasMore && !loading && (
          <button
            type="button"
            onClick={loadMore}
            className="flex w-full items-center justify-center gap-1.5 px-3 py-2.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              size={12}
              strokeWidth={2}
            />
            Load more
          </button>
        )}
      </div>

      <McpInstallDialog
        open={pendingInstall !== null}
        onOpenChange={(open) => {
          if (!open) setPendingInstall(null);
        }}
        pkg={pendingInstall?.pkg ?? null}
        config={pendingInstall?.config ?? null}
        onInstall={(config) => {
          addServer(config);
          setPendingInstall(null);
        }}
      />
    </div>
  );
}

function displayName(name: string): string {
  const last = name.split("/").pop() ?? name;
  return last
    .replace(/[-_]/g, " ")
    .replace(/\bmcp\b/gi, "")
    .trim();
}

/** Convert a registry entry to a Kai MCP server config. */
function registryEntryToConfig(
  s: McpRegistryEntry["server"],
): McpServerConfig | null {
  const stdioPkg = s.packages?.find((p) => p.transport.type === "stdio");
  if (stdioPkg) {
    const command = stdioPkg.runtimeHint ?? "npx";
    const args: string[] = [];
    if (stdioPkg.runtimeArguments) {
      for (const arg of stdioPkg.runtimeArguments) args.push(arg.value);
    }
    args.push(stdioPkg.identifier);
    return {
      id: newMcpServerId(),
      name: s.title || displayName(s.name),
      transport: "stdio",
      command,
      args,
      enabled: true,
    };
  }
  const remote = s.remotes?.[0];
  if (remote) {
    const transport =
      (remote.type === "sse" || remote.type === "streamable-http")
        ? ("sse" as const)
        : ("http" as const);
    return {
      id: newMcpServerId(),
      name: s.title || displayName(s.name),
      transport,
      url: remote.url,
      enabled: true,
    };
  }
  return null;
}
