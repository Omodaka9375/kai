import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  type McpRegistryEntry,
} from "@/modules/ai/lib/mcpRegistry";
import { openUrl } from "@tauri-apps/plugin-opener";
import CubeIcon from "@hugeicons/core-free-icons/CubeIcon";
import Link01Icon from "@hugeicons/core-free-icons/Link01Icon";
import SourceCodeIcon from "@hugeicons/core-free-icons/SourceCodeIcon";
import StarIcon from "@hugeicons/core-free-icons/StarIcon";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";

/**
 * Registry-server detail popover (2026-11-14 ask): clicking a server's
 * TITLE in the Extensions list opens a styled popup - twin of the Git
 * Graph commit popover - showing what the one-line row cannot: full
 * description, repo/website links, transport and package details, required
 * env vars. The Install action lives in here too, so the popover is a
 * complete decision surface.
 *
 * Per-row Popover (unlike the git pane's single floating-anchor popover):
 * the list is virtual-ish and rows unmount on pagination, so anchoring to
 * the row's own trigger is simpler and always correct.
 */
export function McpDetailPopover({
  entry,
  installed,
  onInstall,
  children,
}: {
  entry: McpRegistryEntry;
  installed: boolean;
  onInstall: () => void;
  /** The clickable title element (asChild trigger). */
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const s = entry.server;
  const repoMeta = useGithubRepoMeta(open, s.repository?.url);

  const hasStdio = s.packages?.some((p) => p.transport.type === "stdio");
  const transport = hasStdio
    ? "stdio"
    : (s.remotes?.length ?? 0) > 0
      ? "remote"
      : "unknown";

  const author = repoAuthor(s);
  const repoUrl = s.repository?.url;
  const websiteUrl = s.websiteUrl;
  const official =
    entry._meta?.["io.modelcontextprotocol.registry/official"] ?? null;
  const links = [
    repoUrl ? { label: "Repository", url: repoUrl } : null,
    websiteUrl ? { label: "Website", url: websiteUrl } : null,
  ].filter((x): x is { label: string; url: string } => x !== null);

  // Show the package the install would use (stdio preferred), plus remote
  // endpoints when present. Env vars with descriptions are the reason this
  // popover exists: an API-token install should be an informed decision.
  const installPkg = s.packages?.find(
    (p) => p.transport.type === "stdio",
  );
  const envVars = installPkg?.environmentVariables ?? [];
  const remoteUrls = s.remotes?.map((r) => r.url) ?? [];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={4}
        collisionPadding={16}
        avoidCollisions
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="flex w-[380px] max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden rounded-xl p-0 shadow-xl"
      >
        {/* Header: name + transport + version, mirroring the row. */}
        <div className="flex flex-col gap-1 border-b border-border/60 bg-muted/30 px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            <HugeiconsIcon
              icon={CubeIcon}
              size={13}
              strokeWidth={1.75}
              className="shrink-0 text-muted-foreground"
            />
            <span className="truncate text-[12.5px] font-semibold text-foreground">
              {s.title || s.name}
            </span>
            <span className="shrink-0 rounded bg-muted/60 px-1 py-0.5 text-[9px] text-muted-foreground">
              {transport}
            </span>
            <span className="shrink-0 text-[9.5px] text-muted-foreground/80">
              v{s.version}
            </span>
          </div>
          {author ? (
            <span className="text-[10px] text-muted-foreground">
              by {author}
            </span>
          ) : null}
        </div>

        <div className="flex flex-col gap-3 px-3 py-2.5">
          {/* Full description - the row clamps to 2 lines; here it flows. */}
          {s.description ? (
            <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-foreground/85">
              {s.description}
            </p>
          ) : (
            <p className="text-[11px] italic text-muted-foreground">
              No description provided by the registry.
            </p>
          )}

          {/* Registry package id (what gets installed) + remote endpoints. */}
          {installPkg ? (
            <DetailRow label="Package">
              <span className="font-mono text-[10px]">
                {installPkg.runtimeHint ?? "npx"} {installPkg.identifier}
              </span>
            </DetailRow>
          ) : null}
          {remoteUrls.length > 0 ? (
            <DetailRow label="Endpoint">
              <span className="break-all font-mono text-[10px]">
                {remoteUrls[0]}
              </span>
            </DetailRow>
          ) : null}

          {/* Required environment variables: the "what will it ask me for"
              preview the install dialog doesn't give before clicking. */}
          {envVars.length > 0 ? (
            <DetailRow label="Environment">
              <ul className="flex flex-col gap-1">
                {envVars.map((v) => (
                  <li
                    key={v.name}
                    className="flex items-start gap-1.5 text-[10.5px] leading-snug"
                  >
                    <span
                      className={cn(
                        "shrink-0 rounded px-1 py-0.5 font-mono text-[9.5px]",
                        v.isRequired
                          ? "bg-primary/10 text-primary"
                          : "bg-muted/50 text-muted-foreground",
                      )}
                    >
                      {v.name}
                    </span>
                    <span className="min-w-0 flex-1 text-muted-foreground">
                      {v.description ||
                        (v.isRequired ? "Required." : "Optional.")}
                    </span>
                  </li>
                ))}
              </ul>
            </DetailRow>
          ) : null}

          {/* TRUST SIGNALS (2026-11-14 ask): the registry API has NO rating
              or score field, so this section shows only VERIFIABLE facts the
              user can weigh - registry status + age, source availability,
              and (for GitHub repos) live stars + last-push recency. Not an
              invented score; the absence of a signal is itself shown. */}
          <DetailRow label="Trust">
            <div className="flex flex-col gap-1">
              <TrustChip
                ok={official?.status === "active"}
                text={
                  official?.status === "active"
                    ? `Registry-listed (published ${formatRegistryDate(official.publishedAt)})`
                    : official?.status
                      ? `Registry status: ${official.status}`
                      : "Not in the official registry"
                }
              />
              {repoUrl ? (
                <TrustChip
                  ok
                  text="Public source repository"
                />
              ) : (
                <TrustChip
                  ok={false}
                  text="No public source repository listed"
                />
              )}
              {repoMeta === "loading" ? (
                <TrustChip ok text="Checking repository activity…" muted />
              ) : null}
              {repoMeta && repoMeta !== "loading" ? (
                <TrustChip
                  ok={repoMeta.stars >= 100}
                  text={`${formatStars(repoMeta.stars)} stars · updated ${formatRegistryDate(repoMeta.pushedAt)}`}
                  icon={<HugeiconsIcon icon={StarIcon} size={9} strokeWidth={2} className="shrink-0" />}
                />
              ) : null}
            </div>
          </DetailRow>

          {/* External links - open in the system browser. */}
          {links.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {links.map((l) => (
                <button
                  key={l.url}
                  type="button"
                  onClick={() => void openUrl(l.url).catch(console.error)}
                  className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/60 px-2 py-1 text-[10.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <HugeiconsIcon
                    icon={l.label === "Repository" ? SourceCodeIcon : Link01Icon}
                    size={11}
                    strokeWidth={1.75}
                  />
                  {l.label}
                </button>
              ))}
            </div>
          ) : null}

          {/* Install affordance inside the popover: the popup is a complete
              decision surface, not just documentation. */}
          <div className="flex items-center justify-end border-t border-border/40 pt-2.5">
            {installed ? (
              <span className="text-[10.5px] text-emerald-600 dark:text-emerald-400">
                Already installed
              </span>
            ) : (
              <Button
                size="xs"
                variant="outline"
                className="h-6 gap-1 px-2 text-[10px]"
                onClick={() => {
                  onInstall();
                  setOpen(false);
                }}
              >
                Install
              </Button>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
        {label}
      </span>
      {children}
    </div>
  );
}

/** "github.com/org/repo" -> "org". Registry entries have no explicit author
 *  field; the repository host path is the closest reliable signal. */
function repoAuthor(s: McpRegistryEntry["server"]): string | null {
  const url = s.repository?.url ?? s.websiteUrl;
  if (!url) return null;
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    // github.com/org/repo -> org; gitlab.com/groups/sub/repo -> first segment
    return parts.length >= 2 ? parts[0] : null;
  } catch {
    return null;
  }
}

/** One trust line: green dot = positive signal, amber = caution/missing. */
function TrustChip({
  ok,
  text,
  icon,
  muted,
}: {
  ok: boolean;
  text: string;
  icon?: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5 text-[10.5px] leading-snug">
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          muted
            ? "bg-muted-foreground/40"
            : ok
              ? "bg-emerald-500"
              : "bg-amber-500",
        )}
      />
      {icon ?? null}
      <span className="min-w-0 flex-1 text-muted-foreground">{text}</span>
    </span>
  );
}

type GithubRepoMeta = { stars: number; pushedAt: string };

/** Live GitHub repo stats (stars, last push) for the repository URL, fetched
 *  ONLY while the popover is open. GitHub's unauthenticated API allows 60
 *  req/h per IP - plenty for occasional popover peeks, and failures degrade
 *  silently (the chip just doesn't render). Non-GitHub repos are skipped. */
function useGithubRepoMeta(open: boolean, repoUrl?: string): GithubRepoMeta | "loading" | null {
  const [meta, setMeta] = useState<GithubRepoMeta | "loading" | null>(null);
  useEffect(() => {
    if (!open || !repoUrl) {
      setMeta(null);
      return;
    }
    let m: RegExpMatchArray | null = null;
    try {
      const u = new URL(repoUrl);
      if (u.hostname !== "github.com") return;
      m = u.pathname.match(/^\/([^/]+)\/([^/]+)/);
    } catch {
      return;
    }
    if (!m) return;
    const owner = m[1];
    const repo = m[2].replace(/\.git$/, "");
    let cancelled = false;
    setMeta("loading");
    fetch(`https://api.github.com/repos/${owner}/${repo}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { stargazers_count?: number; pushed_at?: string }) => {
        if (cancelled) return;
        setMeta({
          stars: d.stargazers_count ?? 0,
          pushedAt: d.pushed_at ?? "",
        });
      })
      .catch(() => {
        if (!cancelled) setMeta(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, repoUrl]);
  return meta;
}

function formatStars(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/** ISO date -> "Jan 2026" style; "" for empty. */
function formatRegistryDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
  });
}
