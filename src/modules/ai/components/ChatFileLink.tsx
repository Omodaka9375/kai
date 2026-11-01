import type { ComponentProps } from "react";
import { getActiveProjectRuntime } from "../store/chatStore";

/**
 * Clickable file links in agent chat (2026-11-02 user ask: "when agent
 * writes local or external relative links make it clickable, e.g.
 * docs/report.md").
 *
 * Streamdown renders `[label](docs/report.md)` as an <a href="docs/report.md">
 * — a RELATIVE href that the Tauri webview cannot navigate. This override
 * intercepts the anchor and routes it:
 *
 *   - http(s) links        → unchanged (App's global click interceptor sends
 *                            them to the system browser / preview tab).
 *   - relative repo paths  → resolved against the ACTIVE project's root and
 *                            dispatched as a "Kai:open-file" event, which the
 *                            app shell already routes to the editor (with
 *                            optional :line for `src/app.tsx:42` forms).
 *   - absolute paths      → same, without resolution.
 *
 * The open-file event decouples the renderer from the tab store: message.tsx
 * is a registry component (no app imports), while the listener lives where
 * openFileTab exists. If no listener ever registered (tests, settings
 * window), the link degrades to plain text — never a broken navigation.
 */

/** Path-like href: a repo-relative or absolute file path, with optional
 *  :line / :line:col suffix (jump-to-line forms agents emit a lot). */
const FILE_LINK_RE = /^(?:[A-Za-z]:[\\/][^?#]*|\/[^?#]*|(?:\.{0,2}\/)?[\w.@+-]+(?:\/[\w@+-]+)*\.[\w]+)(?::\d+)?(?::\d+)?[?#]?.*$/;

export function isFileLinkHref(href: string): boolean {
  if (!href) return false;
  if (/^(https?|mailto|data|blob|ftp|file):/i.test(href)) return false;
  return FILE_LINK_RE.test(href);
}

/** Split "src/app.tsx:42:7" → { path, line }. */
export function splitPathLine(href: string): { path: string; line?: number } {
  // Tolerate a leading "./" and URL-ish suffixes (#anchor, ?query) — agents
  // sometimes emit GitHub-style links.
  const stripped = href.replace(/[?#].*$/, "");
  const m = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(stripped);
  if (!m) return { path: stripped };
  const line = m[2] ? Number(m[2]) : undefined;
  return { path: m[1]!, line: line && line > 0 ? line : undefined };
}

/** Registered by the app shell; absent in tests/settings (links go inert). */
let openFileHandler: ((path: string, line?: number) => void) | null = null;
export function registerChatFileOpen(
  fn: ((path: string, line?: number) => void) | null,
): void {
  openFileHandler = fn;
}

/** Resolve a repo-relative path against the ACTIVE project's root. */
export function resolveChatFilePath(href: string): string {
  const { path } = splitPathLine(href);
  const root = getActiveProjectRuntime()?.root;
  if (!root) return path;
  // Absolute path (Windows drive or POSIX) needs no resolution.
  if (/^([A-Za-z]:[\\/]|\/)/.test(path)) return path;
  const sep = root.includes("\\") ? "\\" : "/";
  const cleanRoot = root.replace(/[\\/]+$/, "");
  return `${cleanRoot}${sep}${path.replace(/^[.][/\\]*/, "").replace(/\//g, sep)}`;
}

export function ChatFileLink(props: ComponentProps<"a">) {
  const { href, children, onClick, ...rest } = props;
  if (href && isFileLinkHref(href)) {
    const { path, line } = splitPathLine(href);
    return (
      <a
        {...rest}
        href={undefined}
        role="link"
        tabIndex={0}
        title={line ? `${path}:${line}` : path}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const abs = resolveChatFilePath(href);
          openFileHandler?.(abs, line);
        }}
        className="cursor-pointer font-mono text-[0.92em] text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
      >
        {children}
      </a>
    );
  }
  // Web links and non-path hrefs: plain anchor (App's interceptor routes).
  return (
    <a {...props} className={props.className ?? "text-primary underline underline-offset-2"}>
      {children}
    </a>
  );
}
