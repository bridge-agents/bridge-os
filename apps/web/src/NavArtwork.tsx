import approvalsIcon from "@bridge/ui/assets/approvals-icon.png";
import automationsIcon from "@bridge/ui/assets/automations-icon.png";
import channelsIcon from "@bridge/ui/assets/channels-icon.png";
import chatIcon from "@bridge/ui/assets/chat-icon.png";
import dashboardIcon from "@bridge/ui/assets/dashboard-icon.png";
import generatingIcon from "@bridge/ui/assets/generating-icon.png";
import knowledgeIcon from "@bridge/ui/assets/knowledge-icon.png";
import providersIcon from "@bridge/ui/assets/providers-icon.png";
import recentsIcon from "@bridge/ui/assets/recents-icon.png";
import settingsIcon from "@bridge/ui/assets/settings-icon.png";
import subagentIcon from "@bridge/ui/assets/subagent-icon.png";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "./lib/utils.js";

const ARTWORK = {
  approvals: approvalsIcon,
  automations: automationsIcon,
  channels: channelsIcon,
  chat: chatIcon,
  dashboard: dashboardIcon,
  generating: generatingIcon,
  knowledge: knowledgeIcon,
  providers: providersIcon,
  recents: recentsIcon,
  settings: settingsIcon,
  subagent: subagentIcon,
} as const;

export type NavArtworkName = keyof typeof ARTWORK;

/** Normalizes the supplied transparent, padded artwork into stable icon targets. */
export function NavArtwork({
  name,
  className,
  ...props
}: { name: NavArtworkName } & Omit<ComponentPropsWithoutRef<"span">, "children">) {
  return (
    <span
      className={cn("inline-flex size-5 shrink-0 items-center justify-center", className)}
      aria-hidden="true"
      {...props}
    >
      <img src={ARTWORK[name]} alt="" className="size-[185%] max-w-none object-contain" />
    </span>
  );
}
