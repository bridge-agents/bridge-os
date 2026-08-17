import agentIcon from "@bridge/ui/assets/bridge-agent-icon.png";
import groupAgentIcon from "@bridge/ui/assets/bridge-group-agent-icon.png";
import { cn } from "./lib/utils.js";

export function AgentArtwork({
  group = false,
  className,
}: {
  group?: boolean;
  className?: string;
}) {
  return (
    <img
      src={group ? groupAgentIcon : agentIcon}
      alt=""
      aria-hidden="true"
      className={cn("size-5 shrink-0 object-contain", className)}
    />
  );
}
