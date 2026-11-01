/**
 * Settings tools - agent-driven KAI configuration (theme, editor, terminal,
 * shell, instructions).
 *
 * "Make the editor Nord", "switch to dark theme", "turn vim mode on" - the
 * user shouldn't do a Settings round-trip when the agent can do it. This is
 * the completion of the config surface voice_settings started.
 *
 * THREE tools, because needsApproval is STATICALLY parsed (kaiMdDriftGate)
 * and the tiers are a trust boundary, not a runtime mood:
 *
 *   settings                    (auto)   - READ current values + option lists.
 *   settings_update             (auto)   - cosmetics & comfort: reversible,
 *                                          user-visible, zero risk.
 *   settings_update_restricted  (card)   - behavioral: changes what KAI does
 *                                          at boot / in future runs.
 *
 * NEVER settable by the agent (stay human-only, same class as the keychain):
 *   - networkPolicy        (the agent's own fence - self-modifying loop)
 *   - commit signing keys  (identity/trust)
 *   - openaiCompatibleBaseURL (repointing the model endpoint is a prompt-
 *     exfiltration vector: the next request ships the conversation to the
 *     new URL)
 *   - shortcuts, sidebar/window layout, recent projects, updater internals
 *
 * Writes go through the store setters (persist + cross-window event), so
 * the main window and Settings window both update live. Every change is
 * audited (sandboxChange kind - the networkPolicy/voice precedent).
 *
 * Core toolset (NOT extended): main agent + Telegram assistant. Personas
 * are EXCLUDED (personaWorkspace) - a headless group participant has no
 * business re-theming the user's app, same class as voice_settings.
 */

import { z } from "zod";
import { tool } from "ai";
import { UI_THEMES } from "@/modules/theme/palettes";
import {
  EDITOR_THEMES,
  setAutostart,
  setCustomInstructions,
  setDefaultModel,
  setDefaultShell,
  setEditorTheme,
  setEditorWordWrap,
  setRestoreWindowState,
  setShowHidden,
  setSubagentMaxSteps,
  setTerminalFontSize,
  setTerminalScrollback,
  setTerminalWebglEnabled,
  setTheme,
  setThinkingMode,
  setUiThemeId,
  setVimMode,
  setZoomLevel,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_SCROLLBACK_MAX,
  TERMINAL_SCROLLBACK_MIN,
  TERMINAL_SCROLLBACK_DEFAULT,
} from "@/modules/settings/store";
import type { ModelId, ThinkingMode } from "@/modules/ai/config";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { auditAppend, AUDIT_KINDS } from "../lib/audit";
import type { ToolContext } from "./context";

/** Theme options shared by the read tool and the cosmetic schema. */
const THEMES = ["system", "light", "dark"] as const;
const THINKING_MODES = ["off", "low", "medium", "high"] as const;
/** Documented defaultShell choices (a custom path is also accepted). */
const SHELLS = ["auto", "cmd", "powershell", "pwsh"] as const;

function clampNumber(
  value: number,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Read back the live store (post-write state, never assumed). */
function currentSettings() {
  const p = usePreferencesStore.getState();
  return {
    theme: p.theme,
    uiThemeId: p.uiThemeId,
    editorTheme: p.editorTheme,
    vimMode: p.vimMode,
    editorWordWrap: p.editorWordWrap,
    showHidden: p.showHidden,
    terminalWebglEnabled: p.terminalWebglEnabled,
    terminalFontSize: p.terminalFontSize,
    terminalScrollback: p.terminalScrollback,
    zoomLevel: p.zoomLevel,
    restoreWindowState: p.restoreWindowState,
    defaultShell: p.defaultShell,
    customInstructions: p.customInstructions,
    autostart: p.autostart,
    defaultModelId: p.defaultModelId,
    thinkingMode: p.thinkingMode,
    subagentMaxSteps: p.subagentMaxSteps,
    // Read-only context the agent benefits from knowing (its own fence).
    networkPolicy: p.networkPolicy,
  };
}

export function buildSettingsTools(_ctx: ToolContext) {
  return {
    settings: tool({
      needsApproval: false,
      description:
        "Read KAI's configuration - current theme, editor, terminal, shell, and agent-behavior settings, plus the valid options for each (themes, editor themes, shells, thinking modes). Use this before changing anything. Security-relevant settings (network policy, commit signing, model endpoint URLs, API keys) are shown read-only and can only be changed by the user in Settings.",
      inputSchema: z.object({}),
      execute: async () => {
        return {
          settings: currentSettings(),
          options: {
            theme: THEMES,
            uiTheme: UI_THEMES.map((t) => ({ id: t.id, label: t.label })),
            editorTheme: EDITOR_THEMES,
            defaultShell: SHELLS,
            thinkingMode: THINKING_MODES,
            terminalFontSize: `${TERMINAL_FONT_SIZE_MIN}-${TERMINAL_FONT_SIZE_MAX}`,
            terminalScrollback: `${TERMINAL_SCROLLBACK_MIN}-${TERMINAL_SCROLLBACK_MAX}`,
          },
          settable: {
            cosmetic:
              "theme, editorTheme, vimMode, editorWordWrap, showHidden, terminalWebglEnabled, terminalFontSize, terminalScrollback, zoomLevel, restoreWindowState (settings_update - no approval)",
            restricted:
              "defaultShell, customInstructions, autostart, defaultModelId, thinkingMode, subagentMaxSteps (settings_update_restricted - needs approval)",
          },
        };
      },
    }),

    settings_update: tool({
      needsApproval: false,
      description:
        "Change KAI's APPEARANCE and editor/terminal comfort settings: uiThemeId (the app's color palette: emerald, nord, tokyo-night, catppuccin, dracula, rose-pine, amber, or default), theme (light/dark/system mode), editorTheme (the code editor's theme), vimMode, editorWordWrap, showHidden, terminalWebglEnabled, terminalFontSize, terminalScrollback, zoomLevel, restoreWindowState. All reversible cosmetics - call `settings` first to see current values and options. Applies immediately across windows.",
      inputSchema: z.object({
        uiThemeId: z
          .enum(UI_THEMES.map((t) => t.id) as [string, ...string[]])
          .describe(
            "Color palette for the whole app (emerald, nord, tokyo-night, catppuccin, dracula, rose-pine, amber, or default for the stock Kai palette).",
          )
          .optional(),
        theme: z
          .enum(THEMES)
          .describe("Light/dark mode: system, light, or dark.")
          .optional(),
        editorTheme: z
          .enum(EDITOR_THEMES)
          .describe("Code-editor theme (nord, tokyo-night, github-dark, ...).")
          .optional(),
        vimMode: z
          .boolean()
          .describe("Vim keybindings in the editor.")
          .optional(),
        editorWordWrap: z
          .boolean()
          .describe("Wrap long lines in the editor.")
          .optional(),
        showHidden: z
          .boolean()
          .describe("Show hidden files/directories in the explorer.")
          .optional(),
        terminalWebglEnabled: z
          .boolean()
          .describe("Hardware-accelerated terminal renderer.")
          .optional(),
        terminalFontSize: z
          .number()
          .describe(
            `Terminal font size (${TERMINAL_FONT_SIZE_MIN}-${TERMINAL_FONT_SIZE_MAX}).`,
          )
          .optional(),
        terminalScrollback: z
          .number()
          .describe(
            `Terminal scrollback lines (${TERMINAL_SCROLLBACK_MIN}-${TERMINAL_SCROLLBACK_MAX}).`,
          )
          .optional(),
        zoomLevel: z
          .number()
          .describe("App zoom (0.5-2.0, 1 = default).")
          .optional(),
        restoreWindowState: z
          .boolean()
          .describe("Restore window size/position on launch.")
          .optional(),
      }),
      execute: async (input) => {
        const changed: string[] = [];
        const p = usePreferencesStore.getState();
        const int = (v: number, min: number, max: number, def: number) =>
          clampNumber(v, min, max, def);

        if (input.uiThemeId !== undefined && input.uiThemeId !== p.uiThemeId) {
          await setUiThemeId(input.uiThemeId);
          changed.push(`uiThemeId=${input.uiThemeId}`);
        }
        if (input.theme !== undefined && input.theme !== p.theme) {
          await setTheme(input.theme);
          changed.push(`theme=${input.theme}`);
        }
        if (
          input.editorTheme !== undefined &&
          input.editorTheme !== p.editorTheme
        ) {
          await setEditorTheme(input.editorTheme);
          changed.push(`editorTheme=${input.editorTheme}`);
        }
        if (input.vimMode !== undefined && input.vimMode !== p.vimMode) {
          await setVimMode(input.vimMode);
          changed.push(`vimMode=${input.vimMode}`);
        }
        if (
          input.editorWordWrap !== undefined &&
          input.editorWordWrap !== p.editorWordWrap
        ) {
          await setEditorWordWrap(input.editorWordWrap);
          changed.push(`editorWordWrap=${input.editorWordWrap}`);
        }
        if (
          input.showHidden !== undefined &&
          input.showHidden !== p.showHidden
        ) {
          await setShowHidden(input.showHidden);
          changed.push(`showHidden=${input.showHidden}`);
        }
        if (
          input.terminalWebglEnabled !== undefined &&
          input.terminalWebglEnabled !== p.terminalWebglEnabled
        ) {
          await setTerminalWebglEnabled(input.terminalWebglEnabled);
          changed.push(`terminalWebglEnabled=${input.terminalWebglEnabled}`);
        }
        if (
          input.terminalFontSize !== undefined &&
          input.terminalFontSize !== p.terminalFontSize
        ) {
          const v = int(
            input.terminalFontSize,
            TERMINAL_FONT_SIZE_MIN,
            TERMINAL_FONT_SIZE_MAX,
            TERMINAL_FONT_SIZE_DEFAULT,
          );
          await setTerminalFontSize(v);
          changed.push(`terminalFontSize=${v}`);
        }
        if (
          input.terminalScrollback !== undefined &&
          input.terminalScrollback !== p.terminalScrollback
        ) {
          const v = int(
            input.terminalScrollback,
            TERMINAL_SCROLLBACK_MIN,
            TERMINAL_SCROLLBACK_MAX,
            TERMINAL_SCROLLBACK_DEFAULT,
          );
          await setTerminalScrollback(v);
          changed.push(`terminalScrollback=${v}`);
        }
        if (input.zoomLevel !== undefined && input.zoomLevel !== p.zoomLevel) {
          // Round to a sane step and clamp - the webview zoom is not a slider.
          const v =
            Math.round(Math.min(2, Math.max(0.5, input.zoomLevel)) * 20) / 20;
          await setZoomLevel(v);
          changed.push(`zoomLevel=${v}`);
        }
        if (
          input.restoreWindowState !== undefined &&
          input.restoreWindowState !== p.restoreWindowState
        ) {
          await setRestoreWindowState(input.restoreWindowState);
          changed.push(`restoreWindowState=${input.restoreWindowState}`);
        }

        if (changed.length > 0) {
          auditAppend(
            AUDIT_KINDS.sandboxChange,
            "settings",
            `appearance settings changed: ${changed.join(", ")}`,
            "",
          );
        }

        return {
          changed: changed.length > 0 ? changed : null,
          settings: currentSettings(),
          hint:
            changed.length === 0
              ? "Nothing changed. Call `settings` to see current values."
              : "Applied immediately.",
        };
      },
    }),

    settings_update_restricted: tool({
      needsApproval: true,
      description:
        "Change KAI's BEHAVIORAL settings - these alter what the app does at boot or in future runs, so they need the user's approval: defaultShell (the shell new terminals use: auto, cmd, powershell, pwsh, or a path), customInstructions (global instructions appended to every agent prompt), autostart (launch KAI at login), defaultModelId (the default chat model), thinkingMode (reasoning depth for thinking-capable models), subagentMaxSteps (step cap for subagents, 1-200). Call `settings` first to see current values.",
      inputSchema: z.object({
        defaultShell: z
          .string()
          .describe(
            "Shell for new terminals: auto, cmd, powershell, pwsh, or a full path.",
          )
          .optional(),
        customInstructions: z
          .string()
          .describe(
            "Global custom instructions for the agent (replaces the current text).",
          )
          .optional(),
        autostart: z.boolean().describe("Start KAI at OS login.").optional(),
        defaultModelId: z
          .string()
          .describe(
            "Model id for new chats (pick from the model picker's known ids).",
          )
          .optional(),
        thinkingMode: z
          .enum(THINKING_MODES)
          .describe("Extended thinking: off, low, medium, or high.")
          .optional(),
        subagentMaxSteps: z
          .number()
          .describe("Max steps a subagent may take (1-200).")
          .optional(),
      }),
      execute: async (input) => {
        const changed: string[] = [];
        const p = usePreferencesStore.getState();

        if (
          input.defaultShell !== undefined &&
          input.defaultShell !== p.defaultShell
        ) {
          await setDefaultShell(input.defaultShell);
          changed.push(`defaultShell=${input.defaultShell}`);
        }
        if (
          input.customInstructions !== undefined &&
          input.customInstructions !== p.customInstructions
        ) {
          await setCustomInstructions(input.customInstructions);
          changed.push(
            `customInstructions=${input.customInstructions ? "<updated>" : "<cleared>"}`,
          );
        }
        if (input.autostart !== undefined && input.autostart !== p.autostart) {
          await setAutostart(input.autostart);
          changed.push(`autostart=${input.autostart}`);
        }
        if (
          input.defaultModelId !== undefined &&
          input.defaultModelId !== p.defaultModelId
        ) {
          await setDefaultModel(input.defaultModelId as ModelId);
          changed.push(`defaultModelId=${input.defaultModelId}`);
        }
        if (
          input.thinkingMode !== undefined &&
          input.thinkingMode !== p.thinkingMode
        ) {
          await setThinkingMode(input.thinkingMode as ThinkingMode);
          changed.push(`thinkingMode=${input.thinkingMode}`);
        }
        if (
          input.subagentMaxSteps !== undefined &&
          input.subagentMaxSteps !== p.subagentMaxSteps
        ) {
          const v = clampNumber(input.subagentMaxSteps, 1, 200, 24);
          await setSubagentMaxSteps(v);
          changed.push(`subagentMaxSteps=${v}`);
        }

        if (changed.length > 0) {
          auditAppend(
            AUDIT_KINDS.sandboxChange,
            "settings",
            `behavioral settings changed: ${changed.join(", ")}`,
            "",
          );
        }

        return {
          changed: changed.length > 0 ? changed : null,
          settings: currentSettings(),
          hint:
            changed.length === 0
              ? "Nothing changed. Call `settings` to see current values."
              : "Applied. Behavioral changes take effect per their scope (new terminals, next launches, future runs).",
        };
      },
    }),
  };
}
