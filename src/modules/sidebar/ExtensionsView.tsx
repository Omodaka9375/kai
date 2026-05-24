import { Button } from "@/components/ui/button";
import { newMcpServerId, type McpServerConfig } from "@/modules/ai/lib/mcp";
import {
  fetchRegistryServers,
  type McpRegistryEntry,
} from "@/modules/ai/lib/mcpRegistry";
import { useMcpStore } from "@/modules/ai/store/mcpStore";
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
  const [search, setSearch] = useState("");
  const [entries, setEntries] = useState<McpRegistryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const debounceRef = useRef(0);
  const installedServers = useMcpStore((s) => s.servers);
  const addServer = useMcpStore((s) => s.addServer);
  const hydrate = useMcpStore((s) => s.hydrate);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const doFetch = useCallback(
    async (query: string, nextCursor?: string) => {
      setLoading(true);
      setError(null);
      try {
        const resp = await fetchRegistryServers({
          search: query || undefined,
          cursor: nextCursor,
        });
        if (nextCursor) {
          setEntries((prev) => [...prev, ...resp.servers]);
        } else {
          setEntries(resp.servers);
        }
        setCursor(resp.metadata.nextCursor);
        setHasMore(
          resp.metadata.nextCursor !== null && resp.servers.length > 0,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void doFetch("");
  }, [doFetch]);

  useEffect(() => {
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      void doFetch(search);
    }, 300);
    return () => window.clearTimeout(debounceRef.current);
  }, [search, doFetch]);

  const loadMore = () => {
    if (cursor && !loading) void doFetch(search, cursor);
  };

  const isInstalled = (name: string) =>
    installedServers.some(
      (s) => s.name === name || s.name === displayName(name),
    );

  const install = (entry: McpRegistryEntry) => {
    const config = registryEntryToConfig(entry.server);
    if (!config) return;
    addServer(config);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center border-b border-border/60 px-3">
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          MCP Registry
        </span>
      </div>
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border/60 px-2">
        <HugeiconsIcon
          icon={Search01Icon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground/70"
        />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search MCP servers\u2026"
          spellCheck={false}
          className="w-full bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/50"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <div className="px-3 py-4 text-center text-[11px] text-destructive">
            {error}
          </div>
        )}

        {entries.length === 0 && !loading && !error && (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
            <HugeiconsIcon
              icon={PuzzleIcon}
              size={20}
              strokeWidth={1.5}
              className="text-muted-foreground/60"
            />
            <span className="text-[11px] text-muted-foreground">
              {search ? "No servers found." : "Loading registry\u2026"}
            </span>
          </div>
        )}

        <ul className="flex flex-col">
          {entries.map((entry) => {
            const s = entry.server;
            const installed = isInstalled(s.name);
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

        {loading && (
          <div className="px-3 py-3 text-center text-[11px] text-muted-foreground">
            Loading\u2026
          </div>
        )}

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
      remote.type === "sse" ? ("sse" as const) : ("http" as const);
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
