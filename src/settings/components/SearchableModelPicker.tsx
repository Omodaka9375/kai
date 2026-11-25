import { useEffect, useMemo, useState } from "react";
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/lib/utils";
import {
  PROVIDERS,
  getModel,
  providerNeedsKey,
  type ModelId,
  type ModelInfo,
  type ProviderId,
} from "@/modules/ai/config";
import { useOpenRouterModelsStore } from "@/modules/ai/store/openrouterModelsStore";
import { getAllKeys, type ProviderKeys } from "@/modules/ai/lib/keyring";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { ProviderIcon } from "./ProviderIcon";

type Props = {
  /** Selected model id — `null` follows the app's default model. */
  value: string | null;
  onChange: (next: string | null) => void;
  disabled?: boolean;
};

/** Trigger label: the picked model, or `Default — <label>` when following
 *  the app default. Dynamic ids resolve through getModel() (registry +
 *  OpenRouter external lookup); a truly unknown id falls back to its
 *  synthetic entry - never crashes. */
function currentSelection(value: string | null, defaultModelId: ModelId): {
  label: string;
  hint: string;
  provider: ProviderId;
} {
  if (value == null) {
    const d = getModel(defaultModelId);
    return { label: `Default — ${d.label}`, hint: d.hint, provider: d.provider };
  }
  const m = getModel(value as ModelId);
  return { label: m.label, hint: m.hint, provider: m.provider };
}

/**
 * Searchable model picker (Popover + cmdk). Lists the MERGED model catalog
 * (hardcoded registry + auto-synced OpenRouter models - the same list the
 * status-bar picker shows) grouped by provider with key-aware availability,
 * plus a "Follow default" entry so a surface can explicitly ride the app's
 * default model.
 */
export function SearchableModelPicker({ value, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [keys, setKeys] = useState<ProviderKeys | null>(null);

  const defaultModelId = usePreferencesStore((s) => s.defaultModelId);
  const openaiCompatibleModelId = usePreferencesStore(
    (s) => s.openaiCompatibleModelId,
  );
  // Proxy endpoint (MemoChain): available only when fully configured.
  const proxyBaseURL = usePreferencesStore((s) => s.proxyBaseURL);
  const proxyModelId = usePreferencesStore((s) => s.proxyModelId);
  const orModels = useOpenRouterModelsStore((s) => s.models);
  const orFetch = useOpenRouterModelsStore((s) => s.fetch);

  // Fresh key availability + catalog sync each time the popover opens -
  // both can change elsewhere without this component re-rendering. The
  // fetch is TTL/dedup-guarded in the store, so re-opening is cheap.
  useEffect(() => {
    if (!open) return;
    void getAllKeys().then(setKeys);
    void orFetch();
  }, [open, orFetch]);

  // Group the merged catalog by provider, keeping PROVIDERS order. The
  // store already dedupes hardcoded ids against fetched ones.
  const grouped = useMemo(() => {
    const byProvider = new Map<ProviderId, ModelInfo[]>();
    for (const m of orModels) {
      const list = byProvider.get(m.provider);
      if (list) list.push(m);
      else byProvider.set(m.provider, [m]);
    }
    return PROVIDERS.filter((p) => byProvider.has(p.id)).map((p) => ({
      provider: p,
      models: byProvider.get(p.id) as ModelInfo[],
    }));
  }, [orModels]);

  const isAvailable = (id: string, provider: ProviderId): boolean => {
    if (id === "openai-compatible-custom")
      return !!openaiCompatibleModelId.trim();
    if (id === "proxy-custom")
      return !!proxyBaseURL.trim() && !!proxyModelId.trim();
    if (!providerNeedsKey(provider)) return true;
    // Keys still loading → don't flash everything disabled.
    return keys == null || !!keys[provider];
  };

  const sel = currentSelection(value, defaultModelId);
  const defaultModel = getModel(defaultModelId);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          disabled={disabled}
          className="h-9 w-80 max-w-full justify-between gap-2 px-2.5 text-[12px] font-normal"
        >
          <span className="flex min-w-0 items-center gap-2">
            <ProviderIcon provider={sel.provider} size={14} />
            <span className="truncate">{sel.label}</span>
            <span className="shrink-0 text-muted-foreground">· {sel.hint}</span>
          </span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={12}
            strokeWidth={2}
            className="opacity-70"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-96 p-0">
        <Command>
          <CommandInput placeholder="Search models…" />
          <CommandList>
            <CommandEmpty>No models found.</CommandEmpty>
            <CommandGroup heading="Default">
              <CommandItem
                value="default"
                keywords={[defaultModel.label, defaultModel.hint]}
                data-checked={value == null ? true : undefined}
                onSelect={() => {
                  onChange(null);
                  setOpen(false);
                }}
                className={cn(
                  "flex items-start gap-2 text-[12px]",
                  value == null && "bg-accent/50",
                )}
              >
                <span className="flex flex-1 flex-col">
                  <span>Follow default — {defaultModel.label}</span>
                  <span className="text-[10px] text-muted-foreground">
                    Whatever Settings → Models → Default model is set to.
                  </span>
                </span>
              </CommandItem>
            </CommandGroup>
            {grouped.map(({ provider: p, models }) => (
              <CommandGroup key={p.id} heading={p.label}>
                {models.map((m) => {
                  const available = isAvailable(m.id, m.provider);
                  return (
                    <CommandItem
                      key={m.id}
                      value={m.id}
                      keywords={[m.label, m.description, p.label]}
                      disabled={!available}
                      data-checked={m.id === value ? true : undefined}
                      onSelect={() => {
                        onChange(m.id as ModelId);
                        setOpen(false);
                      }}
                      className={cn(
                        "flex items-start gap-2 text-[12px]",
                        m.id === value && "bg-accent/50",
                      )}
                    >
                      <span className="flex flex-1 flex-col">
                        <span>{m.label}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {m.description}
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
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
