# ADR-0006: Web client is a Vite + React SPA; theming via design tokens (Tailwind v4 + CSS variables)

Status: accepted (2026-08-12)

## Context
The web app is a dashboard/chat product behind auth — no SEO, no public
pages needing SSR. The API-first rule keeps all domain logic server-side.
Branding: Bridge look is fixed; users customise accent/background/appearance
via tokens only.

## Decision
- **Vite + React SPA** (React 19), not Next.js: no SSR runtime to operate in
  self-host Docker, no second server holding logic that belongs in the API,
  static files served by anything. React Router for client routing.
- **Tailwind v4 CSS-first** with all colors/radii/spacing defined as CSS
  custom properties in `@bridge/ui` (`tokens.css`). Components consume
  tokens; user customisation (accent, background, appearance) rewrites token
  values at runtime — never component styles. Bridge logo, name, and core
  design language are not themeable.
- Dark is the default appearance, matching the brand.
- shadcn/Radix primitives may be added per-component when Phase 5/6 needs
  them; not vendored preemptively.

## Consequences
- Web build output is static; desktop (Tauri) wraps the same bundle later.
- If SSR is ever genuinely needed (marketing site), it is a separate app,
  not a rewrite of this one.
