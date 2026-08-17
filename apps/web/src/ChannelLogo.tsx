import { Hash, MessageSquareMore } from "lucide-react";
import { siDiscord, siImessage, siMatrix, siSignal, siTelegram, siWhatsapp } from "simple-icons";
import { cn } from "./lib/utils.js";

const ICONS = {
  telegram: siTelegram,
  discord: siDiscord,
  whatsapp: siWhatsapp,
  imessage: siImessage,
  signal: siSignal,
  matrix: siMatrix,
} as const;

const STYLES: Record<string, string> = {
  telegram: "bg-[#26a5e4] text-white",
  discord: "bg-[#5865f2] text-white",
  slack: "bg-white text-[#4a154b] ring-1 ring-border dark:bg-white",
  whatsapp: "bg-[#25d366] text-white",
  imessage: "bg-[#34c759] text-white",
  "microsoft-teams": "bg-[#6264a7] text-white",
  signal: "bg-[#3a76f0] text-white",
  matrix: "bg-black text-white",
};

export function ChannelLogo({ type, className }: { type: string; className?: string }) {
  const icon = ICONS[type as keyof typeof ICONS];
  return (
    <span
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center rounded-md",
        STYLES[type] ?? "bg-muted text-muted-foreground",
        className,
      )}
      aria-hidden="true"
    >
      {icon ? (
        <svg viewBox="0 0 24 24" className="size-5 fill-current">
          <title>{type} logo</title>
          <path d={icon.path} />
        </svg>
      ) : type === "slack" ? (
        <Hash className="size-5" />
      ) : (
        <MessageSquareMore className="size-5" />
      )}
    </span>
  );
}
