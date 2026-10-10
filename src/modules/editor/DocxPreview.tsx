/**
 * Read-only DOCX preview — mammoth converts the document to semantic HTML,
 * rendered here with editor-consistent typography. Read-only: DOCX is a
 * zipped XML format; CodeMirror cannot edit it meaningfully, so this pane
 * exists for orientation ("what's in this file") — the AI tools extract
 * raw text for analysis.
 */

import { native } from "@/modules/ai/lib/native";
import { useEffect, useState } from "react";

function sanitizeHtml(html: string): string {
  // Mammoth output is semantic markup (h1-h6, p, ul/ol/li, table, strong,
  // em, a, img). We strip scripts/styles/event handlers/frames defensively —
  // the docx is an untrusted file, and one malformed parse shouldn't get
  // script execution in the webview.
  const doc = new DOMParser().parseFromString(
    `<div id="root">${html}</div>`,
    "text/html",
  );
  const root = doc.getElementById("root");
  if (!root) return "";
  root.querySelectorAll("script, style, iframe, object, embed, link").forEach((el) => el.remove());
  root.querySelectorAll("*").forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || (name === "href" && attr.value.trim().toLowerCase().startsWith("javascript:"))) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return root.innerHTML;
}

export function DocxPreview({ path }: { path: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setError(null);
    (async () => {
      try {
        const bytes = await native.readFileBytes(path);
        const mammoth = await import("mammoth");
        const result = await mammoth.convertToHtml({
          arrayBuffer: new Uint8Array(bytes).buffer,
        });
        if (!cancelled) setHtml(sanitizeHtml(result.value));
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-xs text-destructive">
        {error}
      </div>
    );
  }
  if (html === null) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Loading document…
      </div>
    );
  }
  if (!html.trim()) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Empty document.
      </div>
    );
  }
  return (
    <div className="h-full overflow-auto px-6 py-4">
      <div
        className="docx-prose mx-auto max-w-3xl text-[13px] leading-relaxed [&_a]:text-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_h1]:mb-3 [&_h1]:mt-5 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-3 [&_h3]:font-semibold [&_img]:max-w-full [&_li]:mb-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-3 [&_p]:mt-0 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border/60 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border/60 [&_th]:bg-muted [&_th]:px-2 [&_th]:py-1 [&_ul]:list-disc [&_ul]:pl-5"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
