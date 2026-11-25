import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  MODELS,
  PROVIDERS,
  getModel,
  providerNeedsKey,
  type ModelId,
  type ProviderId,
  type ThinkingMode,
  type VisionOverride,
} from "@/modules/ai/config";
import { clearKey, getAllKeys, setKey } from "@/modules/ai/lib/keyring";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  emitKeysChanged,
  setDefaultModel,
  setOpenaiCompatibleBaseURL,
  setOpenaiCompatibleContextSize,
  setOpenaiCompatibleModelId,
  setOpenaiCompatibleThinkingMode,
  setOpenaiCompatibleVision,
  setProxyBaseURL,
  setProxyModelId,
} from "@/modules/settings/store";
import { invoke } from "@tauri-apps/api/core";
import { useOpenRouterModelsStore } from "@/modules/ai/store/openrouterModelsStore";
import type { ModelInfo } from "@/modules/ai/config";
import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import CheckmarkCircle02Icon from "@hugeicons/core-free-icons/CheckmarkCircle02Icon";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import TestTubeIcon from "@hugeicons/core-free-icons/TestTubeIcon";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";
import { ProviderIcon } from "../components/ProviderIcon";
import { ProviderKeyCard } from "../components/ProviderKeyCard";
import { SectionHeader } from "../components/SectionHeader";
import { FitCheckDialog } from "../components/FitCheckDialog";

type KeysMap = Record<string, string | null>;

export function ModelsSection() {
  const [keys, setKeys] = useState<KeysMap | null>(null);
  const [fitOpen, setFitOpen] = useState(false);
  const defaultModel = usePreferencesStore((s) => s.defaultModelId);
  const openaiCompatModelId = usePreferencesStore(
    (s) => s.openaiCompatibleModelId,
  );

  useEffect(() => {
    void getAllKeys().then(setKeys);
  }, []);

  const onSave = async (provider: ProviderId, value: string) => {
    await setKey(provider, value);
    setKeys((prev) => (prev ? { ...prev, [provider]: value } : prev));
    await emitKeysChanged();
  };

  const onClear = async (provider: ProviderId) => {
    await clearKey(provider);
    setKeys((prev) => (prev ? { ...prev, [provider]: null } : prev));
    await emitKeysChanged();
  };

  if (!keys) {
    return <div className="text-[12px] text-muted-foreground">Loading…</div>;
  }

  const cloudProviders = PROVIDERS.filter(
    (p) =>
      providerNeedsKey(p.id) && p.id !== "openai-compatible",
  );
  const configuredCount = cloudProviders.filter((p) => !!keys[p.id]).length;

  return (
    <div className="flex flex-col gap-7">
      <SectionHeader
        title="Models"
        description="Bring your own keys. They live in your OS keychain and are used only by Kai."
      />

      <DefaultModelBlock
        defaultModel={defaultModel}
        keys={keys}
        openaiCompatModelId={openaiCompatModelId}
        onTest={() => setFitOpen(true)}
      />

      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <Label>Cloud providers</Label>
          <span className="text-[10.5px] text-muted-foreground">
            {configuredCount} of {cloudProviders.length} configured
          </span>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {cloudProviders.map((p) => (
            <ProviderKeyCard
              key={p.id}
              provider={p}
              currentKey={keys[p.id]}
              onSave={(v) => onSave(p.id, v)}
              onClear={() => onClear(p.id)}
            />
          ))}
        </div>
      </div>

      <OpenAICompatibleBlock
        compatKey={keys["openai-compatible"]}
        onSaveKey={(v) => onSave("openai-compatible", v)}
        onClearKey={() => onClear("openai-compatible")}
      />

      <ProxyBlock
        proxyKey={keys["proxy"] ?? null}
        onSaveKey={(v) => onSave("proxy" as ProviderId, v)}
        onClearKey={() => onClear("proxy" as ProviderId)}
      />

      <FitCheckDialog
        open={fitOpen}
        onOpenChange={setFitOpen}
        modelId={defaultModel}
        keys={keys}
      />
    </div>
  );
}

function DefaultModelBlock({
  defaultModel,
  keys,
  openaiCompatModelId,
  onTest,
}: {
  defaultModel: ModelId;
  keys: KeysMap;
  openaiCompatModelId: string;
  onTest: () => void;
}) {
  const m = getModel(defaultModel);
  const [open, setOpen] = useState(false);

  const isAvailable = (modelId: string, providerId: ProviderId): boolean => {
    if (modelId === "openai-compatible-custom")
      return !!openaiCompatModelId.trim();
    return providerNeedsKey(providerId) ? !!keys[providerId] : true;
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label>Default model</Label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2 text-[11px]"
          onClick={onTest}
        >
          <HugeiconsIcon icon={TestTubeIcon} size={13} strokeWidth={1.75} />
          Test model
        </Button>
      </div>
      {/* SEARCHABLE (2026-11-16 report): this was the one model picker with
          NO search — a plain grouped dropdown where the OpenAI Compatible
          group sits near the bottom, so picking a local/custom endpoint
          meant scrolling. Same Popover + cmdk pattern as
          SearchableModelPicker; typing "local", "custom", "ollama" etc.
          matches against labels, descriptions, provider names, and hint
          keywords. */}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className="h-9 justify-between gap-2 px-2.5 text-[12px] font-normal"
          >
            <span className="flex min-w-0 items-center gap-2">
              <ProviderIcon provider={m.provider} size={14} />
              <span className="truncate">{m.label}</span>
              <span className="shrink-0 text-muted-foreground">· {m.hint}</span>
            </span>
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              size={12}
              strokeWidth={2}
              className="opacity-70"
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={6} className="w-96 p-0">
          <Command>
            <CommandInput placeholder="Search models… (try: local, custom, ollama)" />
            <CommandList>
              <CommandEmpty>No models found.</CommandEmpty>
              {PROVIDERS.map((p) => {
                const models = MODELS.filter((x) => x.provider === p.id);
                if (models.length === 0) return null;
                const hasKey = providerNeedsKey(p.id) ? !!keys[p.id] : true;
                return (
                  <CommandGroup key={p.id} heading={p.label}>
                    {models.map((mod) => {
                      const available = isAvailable(mod.id, p.id);
                      return (
                        <CommandItem
                          key={mod.id}
                          value={mod.id}
                          keywords={[
                            mod.label,
                            mod.description,
                            mod.hint,
                            p.label,
                            ...(("tags" in mod ? mod.tags : undefined) ?? []),
                          ]}
                          disabled={!available}
                          data-checked={mod.id === defaultModel ? true : undefined}
                          onSelect={() => {
                            if (!available) return;
                            void setDefaultModel(mod.id as ModelId);
                            setOpen(false);
                          }}
                          className={cn(
                            "flex items-start gap-2 text-[12px]",
                            mod.id === defaultModel && "bg-accent/50",
                          )}
                        >
                          <span className="flex flex-1 flex-col">
                            <span>{mod.label}</span>
                            <span className="text-[10px] text-muted-foreground">
                              {mod.description}
                            </span>
                          </span>
                          {!available ? (
                            <span className="shrink-0 pt-0.5 text-[9.5px] text-muted-foreground/70">
                              no key
                            </span>
                          ) : null}
                        </CommandItem>
                      );
                    })}
                    {!hasKey ? (
                      <div className="px-2 pb-1 text-[9.5px] text-muted-foreground/60">
                        no key
                      </div>
                    ) : null}
                  </CommandGroup>
                );
              })}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** Model ID input with a "Fetch" button that queries /v1/models. */
function ModelIdWithFetch({
  value,
  onChange,
  onBlur,
  baseUrl,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur: (v: string) => void;
  baseUrl: string;
  placeholder: string;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [fetching, setFetching] = useState(false);
  const [open, setOpen] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const fetchModels = async () => {
    if (!baseUrl.trim()) return;
    setFetching(true);
    setFetchError(null);
    try {
      const list = await invoke<string[]>("lm_list_models", {
        baseUrl: baseUrl.trim(),
      });
      setModels(list);
      if (list.length > 0) {
        setOpen(true);
      } else {
        setFetchError("Server returned no models.");
      }
    } catch (e) {
      setModels([]);
      setFetchError(String(e));
    }
    setFetching(false);
  };

  return (
    <div className="flex flex-1 gap-1.5">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <div className="flex flex-1 gap-1.5">
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onBlur={() => onBlur(value.trim())}
            placeholder={placeholder}
            spellCheck={false}
            className="h-8 flex-1 font-mono text-[11.5px]"
          />
          <DropdownMenuTrigger asChild onPointerDown={(e) => e.preventDefault()}>
            <Button
              size="sm"
              variant="outline"
              onClick={(e) => {
                e.preventDefault();
                void fetchModels();
              }}
              disabled={!baseUrl.trim() || fetching}
              className="h-8 px-2.5 text-[11px]"
            >
              {fetching ? "…" : "Fetch"}
            </Button>
          </DropdownMenuTrigger>
        </div>
        <DropdownMenuContent
          align="end"
          side="bottom"
          sideOffset={4}
          className="max-h-[200px] min-w-[240px] overflow-y-auto p-1"
        >
          {models.length === 0 ? (
            <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
              No models found
            </div>
          ) : (
            models.map((m) => (
              <DropdownMenuItem
                key={m}
                onClick={() => {
                  onChange(m);
                  onBlur(m);
                  setOpen(false);
                }}
                className="font-mono text-[11px]"
              >
                {m}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {fetchError && (
        <p className="mt-1 text-[10.5px] text-red-500 dark:text-red-400">
          {fetchError}
        </p>
      )}
    </div>
  );
}

/** Proxy backend-model picker — the SAME merged model list the bottom-right
 *  status-bar picker shows (hardcoded registry + auto-synced OpenRouter
 *  catalog), so picking the backend a MemoChain-class proxy fronts is a
 *  browsable dropdown, not free-text guessing. Free text stays available
 *  (the proxy may serve renamed/passthrough ids the catalog doesn't know),
 *  plus a "Fetch" button listing what the PROXY itself serves (lm_list_models
 *  against the proxy URL) for passthrough proxies. */
function ProxyModelIdField({
  value,
  onChange,
  onCommit,
  baseUrl,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit: (v: string) => void;
  baseUrl: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [proxyModels, setProxyModels] = useState<string[]>([]);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [proxyListOpen, setProxyListOpen] = useState(false);

  // The merged catalog (registry + OpenRouter), grouped by provider. Same
  // store the status-bar picker reads; the fetch is TTL/dedup-guarded.
  const orModels = useOpenRouterModelsStore((s) => s.models);
  const orFetch = useOpenRouterModelsStore((s) => s.fetch);
  useEffect(() => {
    if (open) void orFetch();
  }, [open, orFetch]);

  // Placeholder slots (custom/proxy endpoint entries) are config surfaces,
  // not backend models a proxy would front — exclude them from the list.
  const PLACEHOLDER_IDS = new Set(["openai-compatible-custom", "proxy-custom"]);

  const grouped = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const byProvider = new Map<ProviderId, ModelInfo[]>();
    for (const m of orModels) {
      if (PLACEHOLDER_IDS.has(m.id)) continue;
      if (needle) {
        const hay = `${m.id} ${m.label} ${m.hint} ${m.description ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      const list = byProvider.get(m.provider);
      if (list) list.push(m);
      else byProvider.set(m.provider, [m]);
    }
    return PROVIDERS.filter((p) => byProvider.has(p.id)).map((p) => ({
      provider: p,
      models: byProvider.get(p.id) as ModelInfo[],
    }));
  }, [orModels, search]);

  const fetchProxyModels = async () => {
    if (!baseUrl.trim()) return;
    setFetching(true);
    setFetchError(null);
    try {
      const list = await invoke<string[]>("lm_list_models", {
        baseUrl: baseUrl.trim(),
      });
      setProxyModels(list);
      if (list.length > 0) setProxyListOpen(true);
      else setFetchError("Proxy returned no models.");
    } catch (e) {
      setProxyModels([]);
      setFetchError(String(e));
    }
    setFetching(false);
  };

  return (
    <div className="flex flex-1 gap-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onBlur={() => onCommit(value.trim())}
            placeholder="Pick a backend model (or type any id)"
            spellCheck={false}
            className="h-8 flex-1 font-mono text-[11.5px]"
          />
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={6} className="w-96 p-0">
          <Command>
            <CommandInput
              placeholder="Search backend models…"
              value={search}
              onValueChange={setSearch}
            />
            <CommandList>
              <CommandEmpty>No models found.</CommandEmpty>
              {grouped.map(({ provider: p, models }) => (
                <CommandGroup key={p.id} heading={p.label}>
                  {models.map((m) => (
                    <CommandItem
                      key={m.id}
                      value={m.id}
                      keywords={[m.label, m.hint, m.description ?? "", p.label]}
                      data-checked={m.id === value ? true : undefined}
                      onSelect={() => {
                        onChange(m.id);
                        onCommit(m.id);
                        setOpen(false);
                      }}
                      className={cn(
                        "flex items-start gap-2 text-[12px]",
                        m.id === value && "bg-accent/50",
                      )}
                    >
                      <ProviderIcon provider={p.id} size={14} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">{m.label}</span>
                        <span className="truncate font-mono text-[10px] text-muted-foreground">
                          {m.id}
                        </span>
                      </span>
                      <span className="shrink-0 pt-0.5 text-[9.5px] text-muted-foreground">
                        {m.hint}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <DropdownMenu open={proxyListOpen} onOpenChange={setProxyListOpen}>
        <DropdownMenuTrigger asChild onPointerDown={(e) => e.preventDefault()}>
          <Button
            size="sm"
            variant="outline"
            onClick={(e) => {
              e.preventDefault();
              void fetchProxyModels();
            }}
            disabled={!baseUrl.trim() || fetching}
            title="List the model ids the proxy itself serves"
            className="h-8 px-2.5 text-[11px]"
          >
            {fetching ? "…" : "Fetch"}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          side="bottom"
          sideOffset={4}
          className="max-h-[200px] min-w-[240px] overflow-y-auto p-1"
        >
          {proxyModels.length === 0 ? (
            <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
              No models found
            </div>
          ) : (
            proxyModels.map((m) => (
              <DropdownMenuItem
                key={m}
                onClick={() => {
                  onChange(m);
                  onCommit(m);
                  setProxyListOpen(false);
                }}
                className="font-mono text-[11px]"
              >
                {m}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {fetchError && (
        <p className="mt-1 text-[10.5px] text-red-500 dark:text-red-400">
          {fetchError}
        </p>
      )}
    </div>
  );
}

/** One-click base URLs for common local/LAN OpenAI-compatible servers.
 *  Presets are just quick-fill — the field itself accepts any URL, LAN or
 *  remote, http or https. 127.0.0.1 forms (not localhost) so the Rust ping
 *  path sees a plain loopback IP, and users editing the host octets keep a
 *  valid LAN shape (http://192.168.1.50:11434/v1). */
const LOCAL_SERVER_PRESETS = [
  { label: "Ollama", url: "http://127.0.0.1:11434/v1" },
  { label: "llama.cpp", url: "http://127.0.0.1:8080/v1" },
  { label: "vLLM", url: "http://127.0.0.1:8000/v1" },
  { label: "LM Studio", url: "http://127.0.0.1:1234/v1" },
] as const;

function OpenAICompatibleBlock({
  compatKey,
  onSaveKey,
  onClearKey,
}: {
  compatKey: string | null;
  onSaveKey: (v: string) => Promise<void>;
  onClearKey: () => Promise<void>;
}) {
  const baseURL = usePreferencesStore((s) => s.openaiCompatibleBaseURL);
  const modelId = usePreferencesStore((s) => s.openaiCompatibleModelId);
  const thinkingMode = usePreferencesStore((s) => s.openaiCompatibleThinkingMode);
  const ctxSize = usePreferencesStore((s) => s.openaiCompatibleContextSize);
  const [urlDraft, setUrlDraft] = useState(baseURL);
  const [modelDraft, setModelDraft] = useState(modelId);
  const [keyDraft, setKeyDraft] = useState("");
  const [testStatus, setTestStatus] = useState<
    "idle" | "testing" | "ok" | "fail"
  >("idle");

  useEffect(() => setUrlDraft(baseURL), [baseURL]);
  useEffect(() => setModelDraft(modelId), [modelId]);

  const dirty =
    urlDraft.trim() !== baseURL || modelDraft.trim() !== modelId;

  const save = async () => {
    const u = urlDraft.trim();
    const m = modelDraft.trim();
    if (u !== baseURL) await setOpenaiCompatibleBaseURL(u);
    if (m !== modelId) await setOpenaiCompatibleModelId(m);
  };

  const test = async () => {
    setTestStatus("testing");
    try {
      const status = await invoke<number>("lm_ping", {
        baseUrl: urlDraft,
      });
      setTestStatus(status > 0 ? "ok" : "fail");
    } catch {
      setTestStatus("fail");
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <Label>Local / LAN — OpenAI-compatible endpoint</Label>
      </div>

      <div className="flex flex-col gap-2.5 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
        <FieldRow label="Base URL">
          <div className="flex flex-1 gap-1.5">
            <Input
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              onBlur={() => {
                const v = urlDraft.trim();
                if (v !== baseURL) void setOpenaiCompatibleBaseURL(v);
              }}
              placeholder="http://192.168.1.50:11434/v1"
              spellCheck={false}
              className="h-8 flex-1 font-mono text-[11.5px]"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => void test()}
              disabled={!urlDraft.trim()}
              className="h-8 px-3 text-[11px]"
            >
              Test
            </Button>
            <Button
              size="sm"
              onClick={() => void save()}
              disabled={!dirty}
              className="h-8 px-3 text-[11px]"
            >
              Save
            </Button>
          </div>
          <div className="flex flex-wrap gap-1 pt-1">
            {LOCAL_SERVER_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                title={preset.url}
                onClick={() => {
                  setUrlDraft(preset.url);
                  if (preset.url !== baseURL) void setOpenaiCompatibleBaseURL(preset.url);
                }}
                className={cn(
                  "rounded-md border border-border/60 bg-card/60 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-border hover:text-foreground",
                  urlDraft === preset.url && "border-primary/40 text-foreground",
                )}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </FieldRow>

        <FieldRow label="Model ID">
          <ModelIdWithFetch
            value={modelDraft}
            onChange={setModelDraft}
            onBlur={(v) => { if (v !== modelId) void setOpenaiCompatibleModelId(v); }}
            baseUrl={urlDraft}
            placeholder="llama3.1:8b, qwen2.5-coder-7b-instruct, gpt-5.5, …"
          />
        </FieldRow>

        <FieldRow label="API key">
          {compatKey ? (
            <div className="flex flex-1 items-center gap-1.5">
              <code className="flex-1 truncate rounded bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                {`${compatKey.slice(0, 4)}${"•".repeat(8)}${compatKey.slice(-4)}`}
              </code>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => void onClearKey()}
                title="Remove"
                className="size-7 text-muted-foreground hover:text-destructive"
              >
                <HugeiconsIcon
                  icon={Cancel01Icon}
                  size={12}
                  strokeWidth={1.75}
                />
              </Button>
            </div>
          ) : (
            <div className="flex flex-1 gap-1.5">
              <Input
                type="password"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                placeholder="Optional — leave empty for unauthenticated endpoints"
                spellCheck={false}
                className="h-8 flex-1 font-mono text-[11.5px]"
              />
              <Button
                size="sm"
                onClick={async () => {
                  const v = keyDraft.trim();
                  if (!v) return;
                  await onSaveKey(v);
                  setKeyDraft("");
                }}
                disabled={!keyDraft.trim()}
                className="h-8 px-3 text-[11px]"
              >
                Save
              </Button>
            </div>
          )}
        </FieldRow>

        <FieldRow label="Context (tokens)">
          <ContextSizeRow
            value={ctxSize}
            onCommit={(v) => void setOpenaiCompatibleContextSize(v)}
          />
        </FieldRow>

        <FieldRow label="Reasoning">
          <div className="flex items-center gap-0.5">
            {(["off", "low", "medium", "high"] as ThinkingMode[]).map((mode) => (
              <Button
                key={mode}
                size="sm"
                variant={thinkingMode === mode ? "default" : "outline"}
                onClick={() => void setOpenaiCompatibleThinkingMode(mode)}
                className="h-7 px-2 text-[11px]"
              >
                {mode}
              </Button>
            ))}
          </div>
          <span className="text-[10px] text-muted-foreground">
            Sends reasoning_effort — vLLM, Ollama, Z.AI, Fireworks, etc.
          </span>
        </FieldRow>

        <VisionRow
          value={usePreferencesStore((s) => s.openaiCompatibleVision)}
          onChange={(v) => void setOpenaiCompatibleVision(v)}
        />

        <StatusLine status={testStatus} />
      </div>
    </div>
  );
}

/** Proxy endpoint (MemoChain-class memory proxy). Separate from the local
 *  OpenAI-compatible endpoint: this fronts a REAL backend (OpenRouter /
 *  Anthropic / OpenAI), keys its durable memory capsule by x-session-id, and
 *  the model id is whatever the proxy serves for the chosen backend (often an
 *  OpenRouter-style id). BYOK: the key (optional) rides Authorization as-is. */
function ProxyBlock({
  proxyKey,
  onSaveKey,
  onClearKey,
}: {
  proxyKey: string | null;
  onSaveKey: (v: string) => Promise<void>;
  onClearKey: () => Promise<void>;
}) {
  const baseURL = usePreferencesStore((s) => s.proxyBaseURL);
  const modelId = usePreferencesStore((s) => s.proxyModelId);
  const [urlDraft, setUrlDraft] = useState(baseURL);
  const [modelDraft, setModelDraft] = useState(modelId);
  const [keyDraft, setKeyDraft] = useState("");
  const [testStatus, setTestStatus] = useState<
    "idle" | "testing" | "ok" | "fail"
  >("idle");

  useEffect(() => setUrlDraft(baseURL), [baseURL]);
  useEffect(() => setModelDraft(modelId), [modelId]);

  const dirty =
    urlDraft.trim() !== baseURL || modelDraft.trim() !== modelId;

  const save = async () => {
    const u = urlDraft.trim();
    const m = modelDraft.trim();
    if (u !== baseURL) await setProxyBaseURL(u);
    if (m !== modelId) await setProxyModelId(m);
  };

  const test = async () => {
    setTestStatus("testing");
    try {
      const status = await invoke<number>("lm_ping", { baseUrl: urlDraft });
      setTestStatus(status > 0 ? "ok" : "fail");
    } catch {
      setTestStatus("fail");
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <Label>Proxy endpoint — memory proxy (MemoChain)</Label>
        <span className="text-[10.5px] text-muted-foreground">
          An OpenAI-compatible memory proxy fronting any backend. Requests
          carry x-session-id so the proxy keys one durable memory capsule per
          chat session — and the proxy owns context memory, so no local
          compaction happens for sessions it serves.
        </span>
      </div>

      <div className="flex flex-col gap-2.5 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
        <FieldRow label="Base URL">
          <div className="flex flex-1 gap-1.5">
            <Input
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              onBlur={() => {
                const v = urlDraft.trim();
                if (v !== baseURL) void setProxyBaseURL(v);
              }}
              placeholder="http://host:9001/v1"
              spellCheck={false}
              className="h-8 min-w-0 flex-1 font-mono text-[11.5px]"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => void test()}
              disabled={!urlDraft.trim()}
              className="h-8 px-3 text-[11px]"
            >
              Test
            </Button>
            <Button
              size="sm"
              onClick={() => void save()}
              disabled={!dirty}
              className="h-8 px-3 text-[11px]"
            >
              Save
            </Button>
          </div>
        </FieldRow>

        <FieldRow label="Model ID">
          <ProxyModelIdField
            value={modelDraft}
            onChange={setModelDraft}
            onCommit={(v) => { if (v !== modelId) void setProxyModelId(v); }}
            baseUrl={urlDraft}
          />
        </FieldRow>

        <FieldRow label="API key">
          {proxyKey ? (
            <div className="flex flex-1 items-center gap-1.5">
              <code className="flex-1 truncate rounded bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                {`${proxyKey.slice(0, 4)}${"•".repeat(8)}${proxyKey.slice(-4)}`}
              </code>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => void onClearKey()}
                title="Remove"
                className="size-7 text-muted-foreground hover:text-destructive"
              >
                <HugeiconsIcon
                  icon={Cancel01Icon}
                  size={12}
                  strokeWidth={1.75}
                />
              </Button>
            </div>
          ) : (
            <div className="flex flex-1 gap-1.5">
              <Input
                type="password"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                placeholder="Optional BYOK — forwarded as Authorization to the proxy"
                spellCheck={false}
                className="h-8 flex-1 font-mono text-[11.5px]"
              />
              <Button
                size="sm"
                onClick={async () => {
                  const v = keyDraft.trim();
                  if (!v) return;
                  await onSaveKey(v);
                  setKeyDraft("");
                }}
                disabled={!keyDraft.trim()}
                className="h-8 px-3 text-[11px]"
              >
                Save
              </Button>
            </div>
          )}
        </FieldRow>

        <StatusLine status={testStatus} />
      </div>
    </div>
  );
}

function FieldRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-[11px] tracking-tight text-muted-foreground">
        {label}
      </span>
      <div className="flex flex-1 items-center">{children}</div>
    </div>
  );
}

/** Context-size quick pills (16K / 32K / … / 1M) beside a numeric input.
 *  Pills commit instantly; the input commits on blur/Enter. Values are exact
 *  token counts — the pill labels are just short forms of the same numbers
 *  the provider actually receives. Empty pill match (odd size like 200000)
 *  highlights nothing; the input remains the source of truth. */
const CONTEXT_PRESETS = [
  { label: "16K", value: 16_384 },
  { label: "32K", value: 32_768 },
  { label: "64K", value: 65_536 },
  { label: "128K", value: 131_072 },
  { label: "200K", value: 200_000 },
  { label: "256K", value: 262_144 },
  { label: "1M", value: 1_048_576 },
] as const;

function ContextSizeRow({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(value ? String(value) : "");
  useEffect(() => setDraft(value ? String(value) : ""), [value]);
  const commit = (raw: string) => {
    const v = parseInt(raw.trim(), 10);
    onCommit(Number.isFinite(v) && v > 0 ? v : 0);
  };
  return (
    <div className="flex flex-1 items-center gap-2">
      <Input
        type="number"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit(e.currentTarget.value);
            e.currentTarget.blur();
          }
        }}
        placeholder="auto"
        className="h-8 w-24 font-mono text-[11.5px]"
      />
      <div className="flex flex-wrap items-center gap-1">
        {CONTEXT_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            title={`${p.value.toLocaleString()} tokens`}
            onClick={() => onCommit(p.value)}
            className={cn(
              "rounded-full border px-1.5 py-0.5 text-[10px] transition-colors",
              value === p.value
                ? "border-primary/50 bg-primary/10 text-foreground"
                : "border-border/60 text-muted-foreground hover:border-border hover:text-foreground",
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Vision capability selector for user-configured endpoints. "auto" detects
 *  from the model name (vl / vision / llava / …); "on"/"off" override the
 *  detection — for models whose name gives no hint either way. */
function VisionRow({
  value,
  onChange,
}: {
  value: VisionOverride;
  onChange: (v: VisionOverride) => void;
}) {
  return (
    <FieldRow label="Vision">
      <div className="flex items-center gap-0.5">
        {(["auto", "on", "off"] as VisionOverride[]).map((mode) => (
          <Button
            key={mode}
            size="sm"
            variant={value === mode ? "default" : "outline"}
            onClick={() => onChange(mode)}
            className="h-7 px-2 text-[11px]"
          >
            {mode}
          </Button>
        ))}
      </div>
      <span className="text-[10px] text-muted-foreground">
        Auto detects from the name — set On/Off to force.
      </span>
    </FieldRow>
  );
}

function StatusLine({
  status,
}: {
  status: "idle" | "testing" | "ok" | "fail";
}) {
  if (status === "idle") return null;
  if (status === "testing") {
    return (
      <span className="text-[10.5px] text-muted-foreground">Testing…</span>
    );
  }
  if (status === "ok") {
    return (
      <span className="flex items-center gap-1 text-[10.5px] text-emerald-600 dark:text-emerald-400">
        <HugeiconsIcon icon={CheckmarkCircle02Icon} size={11} strokeWidth={2} />
        Reachable — server responded.
      </span>
    );
  }
  return (
    <span className="text-[10.5px] text-destructive">
      Could not reach the server.
    </span>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}

// Native media generation uses the same provider keys configured above:
// image generation/editing on Google, OpenAI, and xAI; video on Google
// Gemini Omni Flash and xAI Grok Imagine. Other engines are available via
// their official MCP servers in Settings → MCP.



