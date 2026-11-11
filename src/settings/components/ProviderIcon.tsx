import type { ProviderId } from "@/modules/ai/config";
import AiVoiceIcon from "@hugeicons/core-free-icons/AiVoiceIcon";
import ChatGptIcon from "@hugeicons/core-free-icons/ChatGptIcon";
import ClaudeIcon from "@hugeicons/core-free-icons/ClaudeIcon";
import FlashIcon from "@hugeicons/core-free-icons/FlashIcon";
import GoogleGeminiIcon from "@hugeicons/core-free-icons/GoogleGeminiIcon";
import Grok02Icon from "@hugeicons/core-free-icons/Grok02Icon";
import CpuIcon from "@hugeicons/core-free-icons/CpuIcon";
import DeepseekIcon from "@hugeicons/core-free-icons/DeepseekIcon";
import GlobeIcon from "@hugeicons/core-free-icons/GlobeIcon";
import Hexagon01Icon from "@hugeicons/core-free-icons/Hexagon01Icon";
import PlugIcon from "@hugeicons/core-free-icons/Plug01Icon";
import Search01Icon from "@hugeicons/core-free-icons/Search01Icon";
import { HugeiconsIcon } from "@hugeicons/react";

const ICON_BY_PROVIDER = {
  openai: ChatGptIcon,
  anthropic: ClaudeIcon,
  google: GoogleGeminiIcon,
  xai: Grok02Icon,
  cerebras: CpuIcon,
  groq: FlashIcon,
  deepseek: DeepseekIcon,
  mistral: Hexagon01Icon,
  openrouter: GlobeIcon,
  "openai-compatible": PlugIcon,
  zai: CpuIcon,
  // Voice provider (STT/TTS) - a voice glyph distinguishes it from the
  // chat-model providers in the key grid.
  assemblyai: AiVoiceIcon,
  // Search provider (web_search engine) - a search glyph, same rule.
  brave: Search01Icon,
} as const satisfies Record<ProviderId, typeof ChatGptIcon>;

type Props = {
  provider: ProviderId;
  size?: number;
  className?: string;
};

export function ProviderIcon({ provider, size = 14, className }: Props) {
  return (
    <HugeiconsIcon
      icon={ICON_BY_PROVIDER[provider]}
      size={size}
      strokeWidth={1.75}
      className={className}
    />
  );
}
