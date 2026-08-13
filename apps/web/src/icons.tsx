import type { ReactNode } from "react";

/**
 * Inline icons, drawn on a 24-grid and inheriting `currentColor`.
 *
 * A dependency for twenty glyphs would be a dependency to audit, package and
 * ship on three desktop platforms; these are a few hundred bytes of markup.
 *
 * Every icon sits beside a text label or inside a button that carries its own
 * accessible name, so the glyphs are decorative and hidden from assistive
 * tech — one `<svg>` element here is what makes that true everywhere.
 */
type IconProps = { className?: string };

function Glyph({ className = "", children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`h-4 w-4 shrink-0 ${className}`}
    >
      {children}
    </svg>
  );
}

export const ChatIcon = ({ className }: IconProps) => (
  <Glyph className={className}>
    <path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-4.5A8 8 0 0 1 11 4h2a8 8 0 0 1 8 8Z" />
  </Glyph>
);

export const AgentsIcon = ({ className }: IconProps) => (
  <Glyph className={className}>
    <rect x="4" y="8" width="16" height="12" rx="3" />
    <path d="M12 4v4M9 14h.01M15 14h.01" />
  </Glyph>
);

export const ApprovalsIcon = ({ className }: IconProps) => (
  <Glyph className={className}>
    <path d="M12 3 4 6.5v5c0 4.5 3.2 8.4 8 9.5 4.8-1.1 8-5 8-9.5v-5L12 3Z" />
    <path d="m9 12 2 2 4-4" />
  </Glyph>
);

export const ProvidersIcon = ({ className }: IconProps) => (
  <Glyph className={className}>
    <path d="M4 7h16M4 12h16M4 17h16" />
    <circle cx="8" cy="7" r="1.6" />
    <circle cx="15" cy="12" r="1.6" />
    <circle cx="10" cy="17" r="1.6" />
  </Glyph>
);

export const SettingsIcon = ({ className }: IconProps) => (
  <Glyph className={className}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4a2 2 0 1 1 4 0a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4Z" />
  </Glyph>
);

export const DashboardIcon = ({ className }: IconProps) => (
  <Glyph className={className}>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </Glyph>
);

export const AutomationIcon = ({ className }: IconProps) => (
  <Glyph className={className}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7v5l3.5 2" />
  </Glyph>
);

export const ObservabilityIcon = ({ className }: IconProps) => (
  <Glyph className={className}>
    <path d="M3 17l5-6 4 4 4-6 5 5" />
  </Glyph>
);

export const OptimizerIcon = ({ className }: IconProps) => (
  <Glyph className={className}>
    <path d="M12 3v18M5 8l7-5 7 5M7 21h10" />
  </Glyph>
);

export const ChannelsIcon = ({ className }: IconProps) => (
  <Glyph className={className}>
    <path d="M4 11a8 8 0 0 1 8-8M4 11v6a2 2 0 0 0 2 2h1M20 11a8 8 0 0 0-8-8" />
    <rect x="2.5" y="11" width="4" height="6" rx="1.5" />
    <rect x="17.5" y="11" width="4" height="6" rx="1.5" />
  </Glyph>
);

export const KnowledgeIcon = ({ className }: IconProps) => (
  <Glyph className={className}>
    <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5V5.5Z" />
    <path d="M8 7.5h7M8 11h5" />
  </Glyph>
);

export const PlusIcon = ({ className }: IconProps) => (
  <Glyph className={className}>
    <path d="M12 5v14M5 12h14" />
  </Glyph>
);

export const ChevronIcon = ({ className }: IconProps) => (
  <Glyph className={className}>
    <path d="m9 6 6 6-6 6" />
  </Glyph>
);

export const SidebarIcon = ({ className }: IconProps) => (
  <Glyph className={className}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M9.5 4v16" />
  </Glyph>
);

export const SunIcon = ({ className }: IconProps) => (
  <Glyph className={className}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Glyph>
);

export const MoonIcon = ({ className }: IconProps) => (
  <Glyph className={className}>
    <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z" />
  </Glyph>
);
