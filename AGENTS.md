# Bridge Frontend Guidance

Apply these rules to every change that affects the web client in `apps/web`.

## Completed Frontend Handoff

The detailed Phase 1-7 catch-up record is in
`docs/PHASES_1_7_COMPLETION.md`. Read it before treating an older roadmap
deferral as missing work.

The following work is complete and should be preserved and extended rather
than rebuilt:

- The web application has been redesigned around shadcn/ui, with full-width
  operational pages for Chat, Agents, Dashboards, Approvals, Providers, and
  Settings.
- Chat is powered by assistant-ui. It supports streamed markdown, a pixelated
  dot-matrix thinking/loading state, assistant-ui reasoning UI, conversation
  history, and mobile-friendly composition.
- The chat composer supports file/image selection, model selection across all
  connected providers, provider logos, reasoning effort, and fast mode when a
  model exposes the fast service tier.
- Uploaded files are stored by Bridge, sent to the selected agent run, and
  restored as image/file attachments when a conversation is reloaded. Generated
  filesystem artifacts and MCP images/files are also persisted as assistant
  attachments and displayed in chat.
- Codex and Claude Code subscription providers are available through their
  vendor CLIs and OAuth-backed local login. Bridge uses those existing plan
  sessions without storing the subscription credential itself.
- The supplied assets are installed in `packages/ui/assets`: `openai.svg`,
  `bridge-agent-icon.png`, and `bridge-group-agent-icon.png`. OpenAI/Codex
  model choices use the OpenAI mark; agent and group-agent experiences use the
  supplied artwork.
- Metallic is the default secondary/accent treatment. Settings exposes
  metallic, preset, and custom accents, stored locally per user/device.
- Workspace owners and admins can edit the workspace name and description in
  Settings; the API persists these fields in the database.
- The desktop sidebar has a 72px collapsed state with 32px icon targets,
  tooltips, a 40px Bridge mark, and no compressed navigation controls.
- Recent conversations reserve a fixed action column and expose pin/unpin,
  rename, and delete from an always-visible three-dot menu. Labels are cut at
  28 characters before `...`, so long titles cannot cover the menu.
- Dashboard and Recents use their supplied metallic artwork, and Knowledge is
  a live route for durable memory rather than a roadmap placeholder.
- Settings includes API-token management, workspace invitations, local master
  key rotation, and encrypted workspace web-search configuration.
- Supplied metallic artwork is installed for Chat, Channels, Approvals,
  Automations, Knowledge, Settings, Providers, generation actions, and
  subagents. Use `NavArtwork` instead of substituting generic icons for these
  product concepts.
- Conversation history supports persisted pinning, renaming, and deletion.
  Pinned conversations sort above recent threads and sidebar rows retain
  comfortable action-target spacing.
- Provider management lives inside Settings; `/providers` only redirects for
  compatibility. The provider catalog includes OpenAI, Anthropic, Gemini,
  OpenRouter, GitHub Models, DeepSeek, Moonshot, MiniMax, Mistral, Qwen Cloud,
  Groq, xAI, Together, Fireworks, Cerebras, local endpoints, and OAuth CLI plan
  connections for Codex, Claude Code, and GitHub Copilot.
- Channels is an active product route. Telegram, Discord, and Slack are
  functional encrypted-secret adapters bound through agent manifests.
  WhatsApp, iMessage, Teams, Signal, and Matrix remain visible with explicit
  runtime requirements; do not present them as connected until their webhook
  or native-helper runtimes exist.

## Required Stack

- Use **shadcn/ui** components for application UI: inputs, buttons, selects,
  dialogs, sheets, cards, tabs, popovers, tooltips, tables, and form controls.
  Reuse components from `apps/web/src/components/ui` before adding a new one.
- Use **assistant-ui** for all chat and assistant interaction surfaces. Reuse
  `apps/web/src/components/assistant-ui`; do not create a parallel custom chat
  implementation.
- Before making a visual/frontend change, read and apply the installed
  **`frontend-design` skill (Anthropic)**. Its production-quality, purposeful
  interface guidance is mandatory for this repository's frontend work.
- Keep the web app a full-width, operational interface. Do not introduce
  landing-page composition, nested cards, decorative gradients/orbs, or
  marketing-style hero layouts into product routes.

## Existing Patterns

- Add shadcn components through the existing `apps/web/components.json`
  configuration. Do not run assistant-ui's Next.js-only `init` command: Bridge
  is a Vite + React Router application.
- Chat uses `@assistant-ui/react` in `apps/web/src/routes/Chat.tsx` and the
  assistant-ui component set in `apps/web/src/components/assistant-ui`.
  Preserve message streaming, reasoning states, attachment handling, model
  selection, capability-aware no-reasoning and effort options, and fast-mode
  controls when changing chat.
- Use `ToolIcon` for tool grants, MCP calls, and tool activity. It resolves
  native actions, connector aliases, and branded Simple Icons consistently;
  extend its shared mapping instead of adding page-local tool glyphs.
- Use `TabsList size="comfortable"` for prominent icon-and-text segmented
  navigation. It preserves connected controls while providing 44px height,
  larger icons, and readable padding; allow horizontal scrolling on mobile.
- The sidebar has one Chat action rather than a second New Chat button. Start
  chats through `newChatParams` and key assistant-ui runtimes with
  `chatSessionKey`, so clicking Chat discards the prior conversation.
- Automation editing uses human scheduling controls for time, weekdays, and
  intervals while persisting validated cron/duration values internally. Keep
  workspace-aware timezone/model defaults and editable manifest-backed titles.
- Use `ProviderLogo` for provider/model branding and `AgentArtwork` for agent
  and group-agent artwork. Do not replace them with generic avatars or icons.
- Use the theme context in `apps/web/src/theme.tsx` and the token variables in
  `apps/web/src/styles.css`. Metallic is the default accent; user-selected
  accent values must remain persisted.
- Preserve the sidebar's expanded and collapsed layouts. Collapsed navigation
  targets must remain fixed-size, accessible controls with tooltips.
- Keep providers in Settings and channel bindings in agent manifests. Channel
  credentials belong in the encrypted secret store and must never be copied
  into a manifest or browser response.

## Quality Bar

- Use Lucide icons where one exists and give icon-only controls accessible
  labels and tooltips.
- Design for desktop and mobile, avoid horizontal overflow, and keep text
  readable at every supported viewport.
- Make controls functional end to end. In particular, uploads must reach the
  agent and persisted images/files must render after a page reload.
- Run the appropriate checks after frontend changes: `pnpm lint`,
  `pnpm typecheck`, and a browser check against a running web/API stack. Check
  the console, route content, responsive layout, and the affected interaction.
