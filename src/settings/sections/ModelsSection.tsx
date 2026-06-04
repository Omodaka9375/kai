import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  MODELS,
  PROVIDERS,
  getAutocompleteEligibleModels,
  getModel,
  getProvider,
  providerNeedsKey,
  providerSupportsKey,
  type ModelId,
  type ProviderId,
} from "@/modules/ai/config";
import { clearKey, getAllKeys, setKey } from "@/modules/ai/lib/keyring";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  emitKeysChanged,
  setAutocompleteEnabled,
  setAutocompleteModelId,
  setAutocompleteProvider,
  setComfyuiBaseURL,
  setComfyuiWorkflow,
  setDefaultModel,
  setLmstudioBaseURL,
  setLmstudioContextSize,
  setLmstudioModelId,
  setOpenaiCompatibleBaseURL,
  setOpenaiCompatibleContextSize,
  setOpenaiCompatibleModelId,
} from "@/modules/settings/store";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowDown01Icon,
  CheckmarkCircle02Icon,
  Cancel01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";
import { ProviderIcon } from "../components/ProviderIcon";
import { ProviderKeyCard } from "../components/ProviderKeyCard";
import { SectionHeader } from "../components/SectionHeader";

type KeysMap = Record<ProviderId, string | null>;

export function ModelsSection() {
  const [keys, setKeys] = useState<KeysMap | null>(null);
  const defaultModel = usePreferencesStore((s) => s.defaultModelId);
  const lmstudioModelId = usePreferencesStore((s) => s.lmstudioModelId);
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
      providerNeedsKey(p.id) && p.id !== "lmstudio" && p.id !== "openai-compatible",
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
        lmstudioModelId={lmstudioModelId}
        openaiCompatModelId={openaiCompatModelId}
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

      <LocalModelsBlock />

      <OpenAICompatibleBlock
        compatKey={keys["openai-compatible"]}
        onSaveKey={(v) => onSave("openai-compatible", v)}
        onClearKey={() => onClear("openai-compatible")}
      />

      <AutocompleteBlock keys={keys} />

      <MediaProvidersBlock />

      <ComfyUIBlock />
    </div>
  );
}

function DefaultModelBlock({
  defaultModel,
  keys,
  lmstudioModelId,
  openaiCompatModelId,
}: {
  defaultModel: ModelId;
  keys: KeysMap;
  lmstudioModelId: string;
  openaiCompatModelId: string;
}) {
  const m = getModel(defaultModel);

  const isAvailable = (modelId: string, providerId: ProviderId): boolean => {
    if (modelId === "lmstudio-local") return !!lmstudioModelId.trim();
    if (modelId === "openai-compatible-custom")
      return !!openaiCompatModelId.trim();
    return providerNeedsKey(providerId) ? !!keys[providerId] : true;
  };

  return (
    <div className="flex flex-col gap-2">
      <Label>Default model</Label>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className="h-9 justify-between gap-2 px-2.5 text-[12px]"
          >
            <span className="flex items-center gap-2">
              <ProviderIcon provider={m.provider} size={14} />
              <span>{m.label}</span>
              <span className="text-muted-foreground">· {m.hint}</span>
            </span>
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              size={12}
              strokeWidth={2}
              className="opacity-70"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="bottom"
          sideOffset={6}
          avoidCollisions={false}
          className="min-w-[280px] p-1"
        >
          <div className="max-h-[240px] overflow-y-auto overscroll-contain pr-1">
            {PROVIDERS.map((p) => {
              const models = MODELS.filter((x) => x.provider === p.id);
              if (models.length === 0) return null;
              const hasKey = providerNeedsKey(p.id) ? !!keys[p.id] : true;
              return (
                <div key={p.id} className="px-1 pt-1.5 first:pt-1">
                  <div className="mb-0.5 flex items-center gap-1.5 px-2 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                    <ProviderIcon provider={p.id} size={11} />
                    <span>{p.label}</span>
                    {!hasKey ? (
                      <span className="ml-auto text-[9.5px] normal-case tracking-normal text-muted-foreground/70">
                        no key
                      </span>
                    ) : null}
                  </div>
                  {models.map((mod) => {
                    const available = isAvailable(mod.id, p.id);
                    return (
                      <DropdownMenuItem
                        key={mod.id}
                        disabled={!available}
                        onSelect={() =>
                          available && void setDefaultModel(mod.id as ModelId)
                        }
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
                      </DropdownMenuItem>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
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

  const fetchModels = async () => {
    if (!baseUrl.trim()) return;
    setFetching(true);
    try {
      const list = await invoke<string[]>("lm_list_models", {
        baseUrl: baseUrl.trim(),
      });
      setModels(list);
      if (list.length > 0) setOpen(true);
    } catch {
      setModels([]);
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
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void fetchModels()}
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
    </div>
  );
}

function LocalModelsBlock() {
  const baseURL = usePreferencesStore((s) => s.lmstudioBaseURL);
  const modelId = usePreferencesStore((s) => s.lmstudioModelId);
  const [urlDraft, setUrlDraft] = useState(baseURL);
  const [modelDraft, setModelDraft] = useState(modelId);
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
    if (u && u !== baseURL) await setLmstudioBaseURL(u);
    if (m !== modelId) await setLmstudioModelId(m);
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
        <Label>Local — LM Studio</Label>
        <span className="text-[10.5px] leading-relaxed text-muted-foreground">
          Run any GGUF model on your machine via LM Studio's HTTP server. Enable
          the server in LM Studio → Developer tab.
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
                if (v && v !== baseURL) void setLmstudioBaseURL(v);
              }}
              placeholder="http://localhost:1234/v1"
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
        </FieldRow>

        <FieldRow label="Model ID">
          <ModelIdWithFetch
            value={modelDraft}
            onChange={setModelDraft}
            onBlur={(v) => { if (v !== modelId) void setLmstudioModelId(v); }}
            baseUrl={urlDraft}
            placeholder="qwen2.5-coder-7b-instruct"
          />
        </FieldRow>

        <FieldRow label="Context (tokens)">
          <Input
            type="number"
            defaultValue={usePreferencesStore.getState().lmstudioContextSize || ""}
            onBlur={(e) => {
              const v = parseInt(e.target.value, 10);
              void setLmstudioContextSize(Number.isFinite(v) && v > 0 ? v : 0);
            }}
            placeholder="128000"
            className="h-8 w-32 font-mono text-[11.5px]"
          />
        </FieldRow>

        <StatusLine status={testStatus} />

        {!modelId.trim() ? (
          <p className="text-[10.5px] leading-relaxed text-amber-600 dark:text-amber-400">
            Enter the model id that's loaded in LM Studio — e.g. the one shown
            on the server's <span className="font-mono">/v1/models</span> page.
          </p>
        ) : null}
      </div>
    </div>
  );
}

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
        <Label>OpenAI-compatible endpoint</Label>
        <span className="text-[10.5px] leading-relaxed text-muted-foreground">
          Any OpenAI-compatible HTTPS endpoint — vLLM, Z.AI, Fireworks, hosted
          Ollama, etc.
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
                if (v !== baseURL) void setOpenaiCompatibleBaseURL(v);
              }}
              placeholder="https://api.example.com/v1"
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
        </FieldRow>

        <FieldRow label="Model ID">
          <ModelIdWithFetch
            value={modelDraft}
            onChange={setModelDraft}
            onBlur={(v) => { if (v !== modelId) void setOpenaiCompatibleModelId(v); }}
            baseUrl={urlDraft}
            placeholder="gpt-4o, qwen3-max, glm-4.6, …"
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
          <Input
            type="number"
            defaultValue={usePreferencesStore.getState().openaiCompatibleContextSize || ""}
            onBlur={(e) => {
              const v = parseInt(e.target.value, 10);
              void setOpenaiCompatibleContextSize(Number.isFinite(v) && v > 0 ? v : 0);
            }}
            placeholder="128000"
            className="h-8 w-32 font-mono text-[11.5px]"
          />
        </FieldRow>

        <StatusLine status={testStatus} />
      </div>
    </div>
  );
}

function AutocompleteBlock({ keys }: { keys: KeysMap }) {
  const enabled = usePreferencesStore((s) => s.autocompleteEnabled);
  const provider = usePreferencesStore((s) => s.autocompleteProvider);
  const modelId = usePreferencesStore((s) => s.autocompleteModelId);
  const eligible = useMemo(() => getAutocompleteEligibleModels(), []);

  const currentModel = useMemo(
    () =>
      MODELS.find((m) => m.provider === provider && m.id === modelId) ??
      MODELS.find((m) => m.id === modelId) ??
      eligible[0],
    [eligible, provider, modelId],
  );

  const setModel = (id: string, providerId: ProviderId) => {
    void setAutocompleteProvider(providerId);
    void setAutocompleteModelId(id);
  };

  const hasKey = providerSupportsKey(provider)
    ? providerNeedsKey(provider)
      ? !!keys[provider]
      : true
    : true;

  // Group eligible models by provider for the dropdown.
  const grouped = useMemo(() => {
    const map = new Map<ProviderId, (typeof eligible)[number][]>();
    for (const m of eligible) {
      const arr = map.get(m.provider) ?? [];
      arr.push(m);
      map.set(m.provider, arr);
    }
    return map;
  }, [eligible]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <Label>Editor autocomplete</Label>
          <span className="text-[10.5px] leading-relaxed text-muted-foreground">
            Inline ghost-text suggestions in the code editor. Pick a fast model
            (LPU/wafer-scale, local, or a small cloud tier).
          </span>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(v) => void setAutocompleteEnabled(v)}
        />
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
        <FieldRow label="Model">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                className="h-8 flex-1 justify-between gap-2 px-2.5 text-[11.5px]"
              >
                <span className="flex items-center gap-2 truncate">
                  <ProviderIcon provider={currentModel.provider} size={12} />
                  <span className="truncate">{currentModel.label}</span>
                  <span className="text-muted-foreground">
                    · {currentModel.hint}
                  </span>
                </span>
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  size={11}
                  strokeWidth={2}
                  className="opacity-70"
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="max-h-[24rem] min-w-[280px] overflow-y-auto"
            >
              {PROVIDERS.map((p) => {
                const list = grouped.get(p.id);
                if (!list || list.length === 0) return null;
                const pHasKey = providerNeedsKey(p.id) ? !!keys[p.id] : true;
                return (
                  <div key={p.id} className="px-1 pt-1.5 first:pt-1">
                    <div className="mb-0.5 flex items-center gap-1.5 px-2 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                      <ProviderIcon provider={p.id} size={11} />
                      <span>{p.label}</span>
                      {!pHasKey ? (
                        <span className="ml-auto text-[9.5px] normal-case tracking-normal text-muted-foreground/70">
                          no key
                        </span>
                      ) : null}
                    </div>
                    {list.map((m) => (
                      <DropdownMenuItem
                        key={m.id}
                        disabled={!pHasKey}
                        onSelect={() => pHasKey && setModel(m.id, p.id)}
                        className={cn(
                          "text-[11.5px]",
                          m.id === modelId && "bg-accent/50",
                        )}
                      >
                        <span className="flex flex-col">
                          <span>{m.label}</span>
                          <span className="text-[10px] text-muted-foreground">
                            {m.description}
                          </span>
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </div>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </FieldRow>

        {!hasKey ? (
          <span className="text-[10.5px] text-amber-500">
            No API key configured for {getProvider(provider).label}. Add one
            above.
          </span>
        ) : null}
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

function ComfyUIBlock() {
  const baseURL = usePreferencesStore((s) => s.comfyuiBaseURL);
  const workflow = usePreferencesStore((s) => s.comfyuiWorkflow);
  const [urlDraft, setUrlDraft] = useState(baseURL);

  useEffect(() => setUrlDraft(baseURL), [baseURL]);

  const hasWorkflow = workflow.length > 10;

  const uploadWorkflow = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      try {
        JSON.parse(text); // validate
        await setComfyuiWorkflow(text);
      } catch {
        window.alert("Invalid JSON file. Export the workflow from ComfyUI using 'Save (API Format)'.");
      }
    };
    input.click();
  };

  const clearWorkflow = () => void setComfyuiWorkflow("");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <Label>ComfyUI (local)</Label>
        <span className="text-[10.5px] leading-relaxed text-muted-foreground">
          Connect to a local ComfyUI instance. Upload a workflow JSON exported
          via "Save (API Format)" — the agent will inject your prompt
          automatically.
        </span>
      </div>
      <div className="flex flex-col gap-2.5 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
        <FieldRow label="Base URL">
          <Input
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            onBlur={() => {
              const v = urlDraft.trim();
              if (v !== baseURL) void setComfyuiBaseURL(v);
            }}
            placeholder="http://localhost:8188"
            spellCheck={false}
            className="h-8 font-mono text-[11.5px]"
          />
        </FieldRow>
        <FieldRow label="Workflow">
          <div className="flex flex-1 items-center gap-1.5">
            {hasWorkflow ? (
              <>
                <span className="flex-1 truncate text-[11px] text-emerald-600 dark:text-emerald-400">
                  <HugeiconsIcon icon={CheckmarkCircle02Icon} size={11} strokeWidth={2} className="inline mr-1" />
                  Workflow loaded
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={uploadWorkflow}
                  className="h-7 px-2 text-[10.5px]"
                >
                  Replace
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={clearWorkflow}
                  className="h-7 px-2 text-[10.5px] text-muted-foreground hover:text-destructive"
                >
                  Clear
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={uploadWorkflow}
                className="h-7 px-3 text-[10.5px]"
              >
                Upload workflow JSON
              </Button>
            )}
          </div>
        </FieldRow>
      </div>
    </div>
  );
}

const MEDIA_SERVICE = "kai-media";

type MediaProvider = {
  id: string;
  label: string;
  description: string;
  consoleUrl: string;
  placeholder: string;
};

const MEDIA_PROVIDERS: MediaProvider[] = [
  {
    id: "kling",
    label: "Kling AI",
    description: "Video generation (Kling 3.0)",
    consoleUrl: "https://klingai.com/dev",
    placeholder: "Paste Kling API key",
  },
  {
    id: "seedance",
    label: "Seedance (ByteDance)",
    description: "Video generation (Seedance 2.0)",
    consoleUrl: "https://seedance.ai",
    placeholder: "Paste Seedance API key",
  },
];

function MediaProvidersBlock() {
  const [keys, setKeys] = useState<Record<string, string | null>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const loaded: Record<string, string | null> = {};
      for (const p of MEDIA_PROVIDERS) {
        try {
          const v = await invoke<string | null>("secrets_get", {
            service: MEDIA_SERVICE,
            account: p.id,
          });
          loaded[p.id] = v && v.length > 0 ? v : null;
        } catch {
          loaded[p.id] = null;
        }
      }
      setKeys(loaded);
    })();
  }, []);

  const save = async (id: string) => {
    const v = (drafts[id] ?? "").trim();
    if (!v) return;
    setSaving(id);
    try {
      await invoke("secrets_set", {
        service: MEDIA_SERVICE,
        account: id,
        password: v,
      });
      setKeys((prev) => ({ ...prev, [id]: v }));
      setDrafts((prev) => ({ ...prev, [id]: "" }));
    } finally {
      setSaving(null);
    }
  };

  const clear = async (id: string) => {
    try {
      await invoke("secrets_delete", {
        service: MEDIA_SERVICE,
        account: id,
      });
    } catch {
      // already absent
    }
    setKeys((prev) => ({ ...prev, [id]: null }));
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <Label>Media generation</Label>
        <span className="text-[10.5px] leading-relaxed text-muted-foreground">
          API keys for image and video generation providers. OpenAI, Google, and
          xAI reuse your existing keys above.
        </span>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {MEDIA_PROVIDERS.map((p) => {
          const currentKey = keys[p.id] ?? null;
          return (
            <div
              key={p.id}
              className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5"
            >
              <div className="flex items-center gap-2">
                <span className="text-[12.5px] font-medium">{p.label}</span>
                {currentKey ? (
                  <span className="ml-1 inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-px text-[10px] text-emerald-700 dark:text-emerald-300">
                    <HugeiconsIcon icon={CheckmarkCircle02Icon} size={9} strokeWidth={2} />
                    Configured
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => void window.open(p.consoleUrl, "_blank")}
                  className="ml-auto text-[10.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  Get key ↗
                </button>
              </div>
              <span className="text-[10.5px] text-muted-foreground">
                {p.description}
              </span>
              {currentKey ? (
                <div className="flex items-center gap-1.5">
                  <code className="flex-1 truncate rounded bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                    {currentKey.length <= 8
                      ? "•".repeat(currentKey.length)
                      : `${currentKey.slice(0, 4)}${'•'.repeat(8)}${currentKey.slice(-4)}`}
                  </code>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => void clear(p.id)}
                    title="Remove"
                    className="size-7 text-muted-foreground hover:text-destructive"
                  >
                    <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />
                  </Button>
                </div>
              ) : (
                <div className="flex gap-1.5">
                  <Input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={p.placeholder}
                    value={drafts[p.id] ?? ""}
                    onChange={(e) =>
                      setDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void save(p.id);
                    }}
                    className="h-8 flex-1 font-mono text-[11.5px] [&::-ms-reveal]:hidden"
                  />
                  <Button
                    size="sm"
                    onClick={() => void save(p.id)}
                    disabled={saving === p.id || !(drafts[p.id] ?? "").trim()}
                    className="h-8 px-3 text-[11px]"
                  >
                    Save
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
