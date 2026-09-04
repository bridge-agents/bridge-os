import agentIcon from "@bridge/ui/assets/bridge-agent-icon.png";
import groupAgentIcon from "@bridge/ui/assets/bridge-group-agent-icon.png";
import { cn } from "./lib/utils.js";

/**
 * An agent's face: its own icon where it has one, the Bridge artwork where it
 * does not.
 *
 * A chosen emoji is drawn inside an SVG rather than as text so it scales with
 * whatever box it is given — the same component renders a 20px sidebar row and
 * a 44px page header, and font sizing in CSS cannot follow a container that
 * way without measuring it.
 */
export function AgentArtwork({
  group = false,
  icon,
  color,
  className,
}: {
  group?: boolean;
  icon?: string | null;
  color?: string | null;
  className?: string;
}) {
  if (icon?.startsWith("data:image/")) {
    return (
      <img
        src={icon}
        alt=""
        aria-hidden="true"
        className={cn("size-5 shrink-0 rounded-lg object-cover", className)}
      />
    );
  }

  if (icon) {
    return (
      <svg
        viewBox="0 0 40 40"
        aria-hidden="true"
        className={cn("size-5 shrink-0", className)}
        role="presentation"
      >
        <rect width="40" height="40" rx="11" fill={color ?? "currentColor"} fillOpacity={0.16} />
        <text x="20" y="21" fontSize="21" textAnchor="middle" dominantBaseline="central">
          {icon}
        </text>
      </svg>
    );
  }

  return (
    <img
      src={group ? groupAgentIcon : agentIcon}
      alt=""
      aria-hidden="true"
      className={cn("size-5 shrink-0 object-contain", className)}
    />
  );
}
