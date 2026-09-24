import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { McpServerConfig } from "@/modules/ai/lib/mcp";
import type { McpRegistryPackage } from "@/modules/ai/lib/mcpRegistry";
import { useCallback, useEffect, useRef, useState } from "react";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Registry package we're installing from (has env-var metadata). */
  pkg: McpRegistryPackage | null;
  /** Base config (built from the registry entry) to install. */
  config: McpServerConfig | null;
  onInstall: (config: McpServerConfig) => void;
};

/**
 * Install-time configuration for MCP servers that declare environment
 * variables (e.g. an API token). The official registry schema marks each
 * variable required/secret with a description; we prompt once here so the
 * server works on first launch instead of failing silently.
 *
 * Secret values are written into the persisted MCP config like every other
 * MCP setting (kai-mcp.json) — same trust level as the existing manual
 * config form in Settings.
 */
export function McpInstallDialog({
  open,
  onOpenChange,
  pkg,
  config,
  onInstall,
}: Props) {
  const required = pkg?.environmentVariables ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const firstInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const initial: Record<string, string> = {};
    for (const v of required) initial[v.name] = "";
    setValues(initial);
    // Focus the first field once the dialog mounts.
    requestAnimationFrame(() => firstInputRef.current?.focus());
  }, [open, required]);

  const missingRequired = required
    .filter((v) => v.isRequired && !values[v.name]?.trim())
    .map((v) => v.name);

  const submit = useCallback(() => {
    if (!config) return;
    if (missingRequired.length > 0) return;
    const env: Record<string, string> = {};
    for (const v of required) {
      const val = values[v.name]?.trim();
      if (val) env[v.name] = val;
    }
    onInstall(
      Object.keys(env).length > 0 ? { ...config, env: { ...config.env, ...env } } : config,
    );
    onOpenChange(false);
  }, [config, missingRequired, onInstall, onOpenChange, required, values]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Install {config?.name ?? "MCP server"}</DialogTitle>
          <DialogDescription>
            {required.length > 0
              ? "This server needs configuration before it can connect. Values are stored with the server's MCP config."
              : "No configuration needed — install and connect now."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2">
          {required.length === 0 && (
            <p className="text-[12px] text-muted-foreground">
              Ready to install <b>{config?.name}</b>.
            </p>
          )}
          {required.map((v, i) => (
            <label key={v.name} className="flex flex-col gap-1.5">
              <span className="flex items-baseline gap-1.5 text-[12px] font-medium">
                {v.description ?? v.name}
                {v.isRequired ? (
                  <span className="text-destructive">*</span>
                ) : (
                  <span className="font-normal text-muted-foreground">
                    (optional)
                  </span>
                )}
              </span>
              <Input
                ref={i === 0 ? firstInputRef : undefined}
                type={v.isSecret ? "password" : "text"}
                value={values[v.name] ?? ""}
                placeholder={v.name}
                onChange={(e) =>
                  setValues((prev) => ({ ...prev, [v.name]: e.target.value }))
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" && missingRequired.length === 0) {
                    e.preventDefault();
                    submit();
                  }
                }}
              />
            </label>
          ))}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={missingRequired.length > 0}
          >
            Install
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}