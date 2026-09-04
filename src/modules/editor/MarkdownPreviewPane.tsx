import { native } from "@/modules/ai/lib/native";
import { useEffect, useMemo, useState } from "react";
import { Streamdown, type Components } from "streamdown";

type Props = {
  path: string;
  visible: boolean;
};

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

const IMG_TAG_RE = /<img\b([^>]*)>/gi;
const MD_IMAGE_RE = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g;

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"));
  if (m?.[1] != null) return m[1];
  const s = attrs.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, "i"));
  return s?.[1] ?? null;
}

function isRemote(src: string): boolean {
  return /^(?:https?:|data:|blob:|asset:|file:)/i.test(src);
}

function mimeFor(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  return MIME_BY_EXT[path.slice(dot + 1).toLowerCase()] ?? null;
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i + 1) : "";
}

function bytesToBase64(bytes: number[]): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.slice(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Streamdown runs with `skipHtml`, so raw `<img>` tags never render. Convert
 * them to markdown image syntax first — the markdown parser then produces the
 * same hast image node as a `![...](...)` reference.
 */
function htmlImagesToMarkdown(md: string): string {
  return md.replace(IMG_TAG_RE, (_m, attrs: string) => {
    const src = attr(attrs, "src");
    if (!src) return "";
    const alt = attr(attrs, "alt") ?? "";
    return `![${alt}](${src})`;
  });
}

/**
 * Resolve local (non-remote) markdown images to `data:` URLs, keyed by their
 * original `src` string. We deliberately do NOT inline these back into the
 * markdown: Streamdown's sanitizer strips any `src` whose protocol isn't
 * http/https — including `data:`. Instead the resolved URL is handed to a
 * custom `img` component, so the value never passes through the sanitizer.
 */
async function resolveLocalImages(
  md: string,
  filePath: string,
): Promise<Map<string, string>> {
  const baseDir = dirname(filePath);
  const targets = new Map<string, string>(); // abs path -> original src
  md.replace(MD_IMAGE_RE, (_m, _alt, src: string) => {
    if (isRemote(src)) return _m;
    const abs = baseDir ? `${baseDir}${src.replace(/\\/g, "/")}` : src;
    if (!targets.has(abs)) targets.set(abs, src);
    return _m;
  });

  const resolved = new Map<string, string>();
  await Promise.all(
    Array.from(targets.entries()).map(async ([abs, src]) => {
      const mime = mimeFor(abs);
      if (!mime) return;
      try {
        const bytes = await native.readFileBytes(abs);
        resolved.set(src, `data:${mime};base64,${bytesToBase64(bytes)}`);
      } catch {
        // Missing/inaccessible image — leave src unresolved.
      }
    }),
  );
  return resolved;
}

export function MarkdownPreviewPane({ path, visible }: Props) {
  const [content, setContent] = useState<string | null>(null);
  const [images, setImages] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setImages(new Map());
    setError(null);
    native
      .readFile(path)
      .then(async (r) => {
        if (cancelled) return;
        if (r.kind === "text") {
          const md = htmlImagesToMarkdown(r.content);
          const imgs = await resolveLocalImages(md, path);
          if (cancelled) return;
          setContent(md);
          setImages(imgs);
        } else if (r.kind === "binary") {
          setError("Binary file — cannot preview.");
        } else if (r.kind === "toolarge") {
          setError(`File too large (${(r.size / 1024).toFixed(0)} KB).`);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const components = useMemo<Components>(
    () => ({
      img: (props) => {
        const { node, src, alt, ...rest } = props;
        void node;
        const resolved = typeof src === "string" ? images.get(src) : undefined;
        return <img {...rest} src={resolved ?? src} alt={alt} />;
      },
    }),
    [images],
  );

  if (!visible) return null;

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-destructive">
        {error}
      </div>
    );
  }

  if (content === null) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Loading…
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto rounded-md border border-border/60 bg-background">
      <div className="mx-auto max-w-3xl px-8 py-6">
        <Streamdown
          className="prose prose-sm dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
          linkSafety={{ enabled: false }}
          skipHtml
          components={components}
        >
          {content}
        </Streamdown>
      </div>
    </div>
  );
}
