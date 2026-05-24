import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useRef, useState } from "react";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
type Method = (typeof METHODS)[number];

const METHOD_COLORS: Record<Method, string> = {
  GET: "text-emerald-500",
  POST: "text-amber-500",
  PUT: "text-blue-500",
  PATCH: "text-purple-500",
  DELETE: "text-red-500",
  HEAD: "text-muted-foreground",
  OPTIONS: "text-muted-foreground",
};

type HeaderRow = { key: string; value: string };

type ResponseData = {
  status: number;
  headers: Record<string, string>;
  body: string;
  time: number;
};

export function ApiTesterPane({ visible }: { visible: boolean }) {
  const [method, setMethod] = useState<Method>("GET");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState<HeaderRow[]>([
    { key: "Content-Type", value: "application/json" },
  ]);
  const [body, setBody] = useState("");
  const [response, setResponse] = useState<ResponseData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const urlRef = useRef<HTMLInputElement>(null);

  const send = useCallback(async () => {
    if (!url.trim()) {
      urlRef.current?.focus();
      return;
    }
    setLoading(true);
    setError(null);
    setResponse(null);
    const start = performance.now();
    try {
      const hdrs: Record<string, string> = {};
      for (const h of headers) {
        if (h.key.trim()) hdrs[h.key.trim()] = h.value;
      }
      const hasBody = method !== "GET" && method !== "HEAD" && body.trim();
      const resp = await invoke<{
        status: number;
        headers: Record<string, string>;
        body: number[];
      }>("ai_http_request", {
        url: url.trim(),
        method,
        headers: Object.keys(hdrs).length > 0 ? hdrs : undefined,
        body: hasBody
          ? Array.from(new TextEncoder().encode(body))
          : undefined,
        allowPrivateNetwork: true,
      });
      const elapsed = Math.round(performance.now() - start);
      const decoded = new TextDecoder().decode(new Uint8Array(resp.body));
      setResponse({
        status: resp.status,
        headers: resp.headers,
        body: decoded,
        time: elapsed,
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [url, method, headers, body]);

  const addHeader = () => setHeaders((h) => [...h, { key: "", value: "" }]);
  const removeHeader = (i: number) =>
    setHeaders((h) => h.filter((_, idx) => idx !== i));
  const updateHeader = (i: number, field: "key" | "value", v: string) =>
    setHeaders((h) => h.map((r, idx) => (idx === i ? { ...r, [field]: v } : r)));

  const prettyBody = (() => {
    if (!response) return "";
    try {
      return JSON.stringify(JSON.parse(response.body), null, 2);
    } catch {
      return response.body;
    }
  })();

  const statusColor = response
    ? response.status < 300
      ? "text-emerald-500"
      : response.status < 400
        ? "text-amber-500"
        : "text-red-500"
    : "";

  if (!visible) return null;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-[12px]">
      {/* ── URL Bar ── */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        <select
          value={method}
          onChange={(e) => setMethod(e.target.value as Method)}
          className={cn(
            "h-7 rounded-md border border-border/60 bg-muted/80 px-2 text-[12px] font-bold outline-none",
            METHOD_COLORS[method],
          )}
        >
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <Input
          ref={urlRef}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://api.example.com/endpoint"
          className="h-7 flex-1 bg-muted/80 font-mono text-[12px]! focus-visible:ring-0"
          onKeyDown={(e) => {
            if (e.key === "Enter") void send();
          }}
        />
        <Button
          size="sm"
          onClick={() => void send()}
          disabled={loading}
          className="h-7 px-4 text-[11px] font-bold"
        >
          {loading ? "Sending…" : "Send"}
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* ── Request Panel ── */}
        <div className="flex w-1/2 flex-col border-r border-border/60">
          <div className="shrink-0 border-b border-border/40 px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
            Request
          </div>

          {/* Headers */}
          <div className="shrink-0 border-b border-border/40 px-3 py-2">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                Headers
              </span>
              <button
                type="button"
                onClick={addHeader}
                className="text-[10px] text-muted-foreground hover:text-foreground"
              >
                + Add
              </button>
            </div>
            <div className="flex flex-col gap-1">
              {headers.map((h, i) => (
                <div key={i} className="flex items-center gap-1">
                  <Input
                    value={h.key}
                    onChange={(e) => updateHeader(i, "key", e.target.value)}
                    placeholder="Key"
                    className="h-6 flex-1 bg-muted/60 font-mono text-[11px]! focus-visible:ring-0"
                  />
                  <Input
                    value={h.value}
                    onChange={(e) => updateHeader(i, "value", e.target.value)}
                    placeholder="Value"
                    className="h-6 flex-1 bg-muted/60 font-mono text-[11px]! focus-visible:ring-0"
                  />
                  <button
                    type="button"
                    onClick={() => removeHeader(i)}
                    className="px-1 text-muted-foreground hover:text-destructive"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Body */}
          {method !== "GET" && method !== "HEAD" && (
            <div className="min-h-0 flex-1 px-3 py-2">
              <span className="mb-1.5 block text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                Body
              </span>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder='{"key": "value"}'
                className="h-full w-full resize-none rounded-md border border-border/40 bg-muted/60 p-2 font-mono text-[11px] outline-none placeholder:text-muted-foreground/50"
                spellCheck={false}
              />
            </div>
          )}
        </div>

        {/* ── Response Panel ── */}
        <div className="flex w-1/2 flex-col">
          <div className="flex shrink-0 items-center justify-between border-b border-border/40 px-3 py-1.5">
            <span className="text-[11px] font-medium text-muted-foreground">
              Response
            </span>
            {response && (
              <div className="flex items-center gap-3">
                <span className={cn("font-mono font-bold", statusColor)}>
                  {response.status}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {response.time}ms
                </span>
                <button
                  type="button"
                  onClick={() => setShowRaw((v) => !v)}
                  className="text-[10px] text-muted-foreground underline-offset-2 hover:underline"
                >
                  {showRaw ? "Pretty" : "Raw"}
                </button>
              </div>
            )}
          </div>

          {error && (
            <div className="px-3 py-3 text-[11px] text-destructive">
              {error}
            </div>
          )}

          {response && (
            <div className="min-h-0 flex-1 overflow-auto">
              {/* Response Headers */}
              <details className="border-b border-border/40 px-3 py-1.5">
                <summary className="cursor-pointer text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                  Headers ({Object.keys(response.headers).length})
                </summary>
                <div className="mt-1 space-y-0.5 font-mono text-[10px]">
                  {Object.entries(response.headers).map(([k, v]) => (
                    <div key={k}>
                      <span className="text-muted-foreground">{k}:</span>{" "}
                      <span className="text-foreground">{v}</span>
                    </div>
                  ))}
                </div>
              </details>

              {/* Response Body */}
              <pre className="whitespace-pre-wrap break-all p-3 font-mono text-[11px] text-foreground">
                {showRaw ? response.body : prettyBody}
              </pre>
            </div>
          )}

          {!response && !error && !loading && (
            <div className="flex flex-1 items-center justify-center text-[11px] text-muted-foreground">
              Send a request to see the response
            </div>
          )}

          {loading && (
            <div className="flex flex-1 items-center justify-center text-[11px] text-muted-foreground">
              Sending…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
