import {
  Blocks,
  CalendarDays,
  Database,
  FileText,
  Globe2,
  Hash,
  Image,
  type LucideIcon,
  Mail,
  Palette,
  ShoppingBag,
  SquareTerminal,
  UsersRound,
  Video,
} from "lucide-react";
import {
  type SimpleIcon,
  siAirtable,
  siAsana,
  siAtlassian,
  siCloudflare,
  siFigma,
  siGithub,
  siGitlab,
  siGmail,
  siGooglecalendar,
  siGoogledrive,
  siHubspot,
  siIntercom,
  siLinear,
  siNotion,
  siPostgresql,
  siSentry,
  siShopify,
  siSnowflake,
  siSquare,
  siStripe,
  siSupabase,
  siTodoist,
  siVercel,
  siZoom,
} from "simple-icons";
import { cn } from "./lib/utils.js";

const BRAND_ICONS: Record<string, SimpleIcon> = {
  airtable: siAirtable,
  asana: siAsana,
  atlassian: siAtlassian,
  cloudflare: siCloudflare,
  figma: siFigma,
  github: siGithub,
  gitlab: siGitlab,
  gmail: siGmail,
  "google-calendar": siGooglecalendar,
  "google-drive": siGoogledrive,
  hubspot: siHubspot,
  intercom: siIntercom,
  linear: siLinear,
  notion: siNotion,
  postgres: siPostgresql,
  sentry: siSentry,
  shopify: siShopify,
  snowflake: siSnowflake,
  square: siSquare,
  stripe: siStripe,
  supabase: siSupabase,
  todoist: siTodoist,
  vercel: siVercel,
  zoom: siZoom,
};

const TOOL_ALIASES: Record<string, string[]> = {
  ...Object.fromEntries(Object.keys(BRAND_ICONS).map((id) => [id, [id]])),
  "google-calendar": ["google-calendar", "googlecalendar"],
  "google-drive": ["google-drive", "googledrive"],
  postgres: ["postgres", "postgresql"],
  atlassian: ["atlassian", "jira", "confluence"],
  github: ["github"],
  gitlab: ["gitlab"],
  cloudflare: ["cloudflare"],
  salesforce: ["salesforce"],
  slack: ["slack"],
  outlook: ["outlook", "microsoft-365"],
  monday: ["monday"],
  canva: ["canva"],
};

const FALLBACK_ICONS: Record<string, LucideIcon> = {
  filesystem: FileText,
  "web-search": Globe2,
  http: Globe2,
  shell: SquareTerminal,
  delegate: UsersRound,
  gmail: Mail,
  "google-calendar": CalendarDays,
  "google-drive": FileText,
  outlook: Mail,
  slack: Hash,
  zoom: Video,
  postgres: Database,
  salesforce: UsersRound,
  canva: Palette,
  monday: CalendarDays,
  shopify: ShoppingBag,
  image: Image,
};

function normalizedToolName(tool: string) {
  return tool
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Resolves manifest grants, MCP names, and human-readable activity labels. */
export function toolIconKey(tool: string): string {
  const normalized = normalizedToolName(tool);
  if (/^(delegate|subagent)|-delegate-|subagent/.test(normalized)) return "delegate";

  for (const [id, aliases] of Object.entries(TOOL_ALIASES)) {
    if (aliases.some((alias) => normalized === alias || normalized.includes(`-${alias}-`))) {
      return id;
    }
  }

  if (/image|generate-art|render/.test(normalized)) return "image";
  if (/filesystem|read-file|write-file|edit-file|file-search|glob|grep/.test(normalized)) {
    return "filesystem";
  }
  if (/web-search|search-web|browser/.test(normalized)) return "web-search";
  if (/http|fetch|request-url/.test(normalized)) return "http";
  if (/shell|terminal|bash|command/.test(normalized)) return "shell";
  return normalized || "tool";
}

export function ToolIcon({ tool, className }: { tool: string; className?: string }) {
  const key = toolIconKey(tool);
  const brand = BRAND_ICONS[key];
  const Icon = FALLBACK_ICONS[key] ?? Blocks;

  return (
    <span
      data-tool-icon={key}
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-md ring-1 ring-foreground/10",
        brand ? "bg-white" : "bg-muted text-muted-foreground",
        className,
      )}
      style={brand ? { color: `#${brand.hex}` } : undefined}
      aria-hidden="true"
    >
      {brand ? (
        <svg viewBox="0 0 24 24" className="size-[55%] fill-current">
          <title>{brand.title} logo</title>
          <path d={brand.path} />
        </svg>
      ) : (
        <Icon className="size-[55%]" />
      )}
    </span>
  );
}
