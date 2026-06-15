import { cn } from "@/lib/utils";
import { memo, useEffect, useRef, useState } from "react";

let mermaidLoaded = false;
let mermaidReady: Promise<typeof import("mermaid")> | null = null;

/** Lazy-load mermaid and initialize once. */
function getMermaid(): Promise<typeof import("mermaid")> {
  if (mermaidReady) return mermaidReady;
  mermaidReady = import("mermaid").then((m) => {
    if (!mermaidLoaded) {
      m.default.initialize({
        startOnLoad: false,
        theme: "dark",
        securityLevel: "strict",
        fontFamily: "inherit",
      });
      mermaidLoaded = true;
    }
    return m;
  });
  return mermaidReady;
}

let renderCounter = 0;

export const MermaidBlock = memo(function MermaidBlock({
  code,
}: {
  code: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const id = `kai-mermaid-${++renderCounter}`;

    getMermaid()
      .then((m) => m.default.render(id, code))
      .then(({ svg: rendered }) => {
        if (!cancelled) {
          setSvg(rendered);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(String(e?.message ?? e));
          setSvg(null);
        }
        // Mermaid leaves orphaned elements on failure — clean up.
        document.getElementById(`d${id}`)?.remove();
      });

    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    return (
      <div className="not-prose my-2 overflow-hidden rounded-lg border border-border/50 bg-muted/30">
        <div className="flex items-center gap-2 border-b border-border/40 bg-muted/20 px-3 py-1">
          <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            mermaid
          </span>
          <span className="text-[10px] text-destructive">render error</span>
        </div>
        <pre className="m-0 overflow-x-auto px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-foreground">
          {code}
        </pre>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        "not-prose my-2 flex justify-center overflow-x-auto rounded-lg border border-border/50 bg-muted/30 p-4",
        "[&_svg]:max-w-full",
      )}
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    />
  );
});
