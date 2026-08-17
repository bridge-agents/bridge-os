import openAiLogo from "@bridge/ui/assets/openai.svg";
import { Boxes } from "lucide-react";
import {
  siAnthropic,
  siClaude,
  siDeepseek,
  siGithub,
  siGithubcopilot,
  siGooglegemini,
  siMistralai,
  siOllama,
  siOpenrouter,
  siQwen,
  siX,
} from "simple-icons";

const BRAND_ICONS = {
  anthropic: siAnthropic,
  "claude-code": siClaude,
  ollama: siOllama,
  openrouter: siOpenrouter,
  "google-gemini": siGooglegemini,
  "github-models": siGithub,
  "github-copilot": siGithubcopilot,
  deepseek: siDeepseek,
  mistral: siMistralai,
  "qwen-cloud": siQwen,
  xai: siX,
} as const;

const BRAND_STYLES: Record<string, string> = {
  openai: "border border-border bg-white text-black dark:border-white/20",
  codex: "border border-border bg-white text-black dark:border-white/20",
  anthropic: "bg-[#d97757] text-white",
  "claude-code": "bg-[#d97757] text-white",
  openrouter: "bg-[#635bff] text-white",
  ollama: "bg-foreground text-background",
  "openai-compatible": "bg-[#3178c6] text-white",
  "google-gemini": "bg-white text-[#4285f4] ring-1 ring-border",
  "github-models": "bg-[#181717] text-white",
  "github-copilot": "bg-[#181717] text-white",
  deepseek: "bg-[#4d6bfe] text-white",
  moonshot: "bg-black text-white",
  minimax: "bg-[#f04c3e] text-white",
  mistral: "bg-[#ff7000] text-black",
  "qwen-cloud": "bg-[#615ced] text-white",
  groq: "bg-[#f55036] text-white",
  xai: "bg-black text-white",
  "together-ai": "bg-[#111827] text-white",
  "fireworks-ai": "bg-[#f15a24] text-white",
  cerebras: "bg-[#f6c344] text-black",
};

export function ProviderLogo({
  provider,
  className = "",
}: {
  provider: string;
  className?: string;
}) {
  const brand = BRAND_ICONS[provider as keyof typeof BRAND_ICONS];
  const style = BRAND_STYLES[provider] ?? "bg-muted text-muted-foreground";
  return (
    <span
      className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] ${style} ${className}`}
      aria-hidden="true"
    >
      {brand ? (
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current">
          <path d={brand.path} />
        </svg>
      ) : provider === "openai" || provider === "codex" ? (
        <img src={openAiLogo} alt="" className="h-3.5 w-3.5" />
      ) : (
        <span className="text-[9px] font-bold uppercase leading-none">
          {provider === "openai-compatible" ? <Boxes className="size-3.5" /> : provider.slice(0, 2)}
        </span>
      )}
    </span>
  );
}
