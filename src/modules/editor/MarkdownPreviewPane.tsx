import { native } from "@/modules/ai/lib/native";
import { useEffect, useState } from "react";
import { Streamdown } from "streamdown";

type Props = {
  path: string;
  visible: boolean;
};

export function MarkdownPreviewPane({ path, visible }: Props) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    native
      .readFile(path)
      .then((r) => {
        if (cancelled) return;
        if (r.kind === "text") setContent(r.content);
        else if (r.kind === "binary") setError("Binary file — cannot preview.");
        else if (r.kind === "toolarge")
          setError(`File too large (${(r.size / 1024).toFixed(0)} KB).`);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

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
        >
          {content}
        </Streamdown>
      </div>
    </div>
  );
}
