/**
 * Voice (TTS) settings tool - agent-driven engine/voice changes.
 *
 * "Switch to a female voice" / "use the local engine" / "try AssemblyAI"
 * from the user shouldn't require a Settings round-trip. Both TTS consumers
 * (the desktop agent's speakText and the Telegram assistant's voice replies)
 * read the prefs LAZILY at speak time, so a change made here applies to
 * the next utterance with zero extra wiring.
 *
 * Design:
 *  - NAMED voices only (no `gender` param) - the model resolves "female"
 *    against the gender-annotated catalogs in the list output rather than
 *    the tool hardcoding a gender->voice map that goes stale as providers
 *    add voices.
 *  - Preference write, not a file/shell mutation - same class as
 *    save_memory, so the tool auto-executes (no approval card).
 *  - Fully reversible; every change is audited (sandboxChange kind,
 *    matching the network-policy precedent for agent-driven setting
 *    changes).
 *  - Core toolset (NOT extended): main agent + Telegram assistant.
 *    Subagents deliberately excluded - a subagent silently changing the
 *    user's voice is surprising, and they don't speak.
 *
 * Engines:
 *  - "api"        OpenAI TTS (cloud, needs an OpenAI key)
 *  - "assemblyai" AssemblyAI-TTS-1 (cloud, needs an AssemblyAI key)
 *  - "local"      Piper (offline)
 */

import { z } from "zod";
import { tool } from "ai";
import {
  setVoiceTtsApiModel,
  setVoiceTtsApiVoice,
  setVoiceTtsAssemblyVoice,
  setVoiceTtsLocalVoice,
  setVoiceTtsMode,
  type Preferences,
} from "@/modules/settings/store";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { auditAppend, AUDIT_KINDS } from "../lib/audit";
import { ASSEMBLY_VOICES } from "../lib/assemblyai";
import type { ToolContext } from "./context";

/** Curated OpenAI TTS voices with gender notes for natural-language
 *  resolution ("a male voice" -> echo/onyx/ash). Names kept as the source of
 *  truth; the gender note is a hint for selection, not a hard map. */
const OPENAI_VOICES = [
  { name: "alloy", gender: "neutral" },
  { name: "echo", gender: "male" },
  { name: "fable", gender: "male" },
  { name: "onyx", gender: "male" },
  { name: "nova", gender: "female" },
  { name: "shimmer", gender: "female" },
  { name: "coral", gender: "female" },
  { name: "sage", gender: "female" },
  { name: "ash", gender: "male" },
  { name: "ballad", gender: "male" },
  { name: "verse", gender: "female" },
];

/** Representative Piper voices (the local engine) - full list lives with the
 *  engine; these cover the common ask (quality/tone variants). */
const PIPER_VOICES = [
  { name: "en_US-lessac-medium", note: "female, medium quality" },
  { name: "en_US-amy-medium", note: "female, medium quality" },
  { name: "en_US-joe-medium", note: "male, medium quality" },
  { name: "en_US-kristin-medium", note: "female, medium quality" },
  { name: "en_GB-alan-medium", note: "male, medium quality" },
  { name: "en_GB-northern_english_male-medium", note: "male, medium quality" },
];

const OPENAI_TTS_MODELS = ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"];

function currentVoiceSettings() {
  const prefs = usePreferencesStore.getState();
  return {
    mode: prefs.voiceTtsMode,
    apiVoice: prefs.voiceTtsApiVoice,
    apiModel: prefs.voiceTtsApiModel,
    assemblyVoice: prefs.voiceTtsAssemblyVoice,
    localVoice: prefs.voiceTtsLocalVoice,
  };
}

export function buildVoiceTools(_ctx: ToolContext) {
  return {
    voice_settings: tool({
      needsApproval: false,
      description:
        "Get or change the text-to-speech (voice) settings - the voice the assistant speaks replies with, on desktop and Telegram voice notes. Changes apply to the NEXT spoken reply. With no arguments (or list=true) return the current settings and the available voice catalogs for every engine. To change: pass mode (engine), voice (an OpenAI voice name), assemblyVoice (an AssemblyAI voice like aai-jane or aai-audrey), model (OpenAI TTS model), or localVoice (a Piper voice name). Resolve gender or tone requests against the catalogs' notes yourself - there is no gender parameter.",
      inputSchema: z.object({
        mode: z
          .enum(["off", "api", "assemblyai", "local"])
          .describe(
            "TTS engine: 'api' = OpenAI TTS (cloud, needs an OpenAI key), 'assemblyai' = AssemblyAI-TTS-1 (cloud, needs an AssemblyAI key), 'local' = Piper (offline), 'off' = disable spoken replies.",
          )
          .optional(),
        voice: z
          .string()
          .describe(
            "OpenAI voice name (e.g. alloy, echo, nova) - pick from the listed catalog, do not invent names. Applies to the 'api' engine.",
          )
          .optional(),
        assemblyVoice: z
          .string()
          .describe(
            "AssemblyAI voice slug (e.g. aai-jane, aai-audrey) - pick from the listed catalog, do not invent slugs. Applies to the 'assemblyai' engine.",
          )
          .optional(),
        model: z.string().optional(),
        localVoice: z.string().optional(),
        list: z
          .boolean()
          .describe("Return the current settings and voice catalogs.")
          .optional(),
      }),
      execute: async (input) => {
        const changed: string[] = [];
        const prefs = usePreferencesStore.getState();

        if (input.mode !== undefined && input.mode !== prefs.voiceTtsMode) {
          await setVoiceTtsMode(input.mode);
          changed.push(`mode=${input.mode}`);
        }
        if (
          input.voice !== undefined &&
          input.voice.trim() &&
          input.voice !== prefs.voiceTtsApiVoice
        ) {
          await setVoiceTtsApiVoice(input.voice.trim());
          changed.push(`apiVoice=${input.voice.trim()}`);
        }
        if (
          input.assemblyVoice !== undefined &&
          input.assemblyVoice.trim() &&
          input.assemblyVoice !== prefs.voiceTtsAssemblyVoice
        ) {
          await setVoiceTtsAssemblyVoice(input.assemblyVoice.trim());
          changed.push(`assemblyVoice=${input.assemblyVoice.trim()}`);
        }
        if (
          input.model !== undefined &&
          input.model.trim() &&
          input.model !== prefs.voiceTtsApiModel
        ) {
          await setVoiceTtsApiModel(input.model.trim());
          changed.push(`apiModel=${input.model.trim()}`);
        }
        if (
          input.localVoice !== undefined &&
          input.localVoice.trim() &&
          input.localVoice !== prefs.voiceTtsLocalVoice
        ) {
          await setVoiceTtsLocalVoice(input.localVoice.trim());
          changed.push(`localVoice=${input.localVoice.trim()}`);
        }

        if (changed.length > 0) {
          auditAppend(
            AUDIT_KINDS.sandboxChange,
            "voice",
            `voice settings changed: ${changed.join(", ")}`,
            "",
          );
        }

        // Effective settings AFTER the writes (read back, not assumed).
        const now = currentVoiceSettings();
        return {
          changed: changed.length > 0 ? changed : null,
          settings: {
            mode: now.mode as Preferences["voiceTtsMode"],
            apiVoice: now.apiVoice,
            apiModel: now.apiModel,
            assemblyVoice: now.assemblyVoice || "aai-jane",
            localVoice: now.localVoice,
          },
          ...(input.list || changed.length === 0
            ? {
                openaiVoices: OPENAI_VOICES,
                openaiTtsModels: OPENAI_TTS_MODELS,
                assemblyVoices: ASSEMBLY_VOICES,
                piperVoices: PIPER_VOICES,
              }
            : {}),
          hint:
            changed.length === 0
              ? "Nothing changed. Use `list: true` to see the voice catalogs."
              : "Applies to the next spoken reply.",
        };
      },
    }),
  };
}
