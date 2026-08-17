# Bridge Phases 1-7 Completion Addendum

Last verified: 2026-08-15.

This addendum records work completed after the original Phase 1-7 roadmap
handoff. Future agents should preserve and extend these implementations rather
than reopening the old deferred items as if they were missing.

## Product UI

- The Vite web client uses shadcn/ui for product controls and assistant-ui for
  chat, streaming text, reasoning, attachments, and loading states.
- Product routes are full-width operational views; Providers is managed inside
  Settings rather than as a separate destination.
- Chat supports connected-provider model selection, provider artwork,
  reasoning effort, supported fast tiers, durable uploads, generated files,
  streamed markdown, and restored attachments after reload.
- The sidebar uses the supplied Bridge artwork, has a stable 72 px collapsed
  layout, and shows fixed-width conversation action menus for pin/unpin,
  rename, and delete after a deterministic 28-character title cutoff.
- Dashboard and Recents use the supplied metallic artwork. All installed
  navigation artwork is stored at an efficient 256 px source size.
- Knowledge is a live primary route for searchable, filterable durable agent
  memory and curated knowledge, with role-gated create/delete controls.
- Settings includes persisted appearance/accent preferences, editable workspace
  details, provider management, API tokens, invitations, local master-key
  rotation, and workspace web-search configuration.
- Models that expose reasoning controls also expose a persisted `none` choice
  in chat, while models without reasoning controls keep that selector hidden.
- Tool grants and activity share a capability-aware icon resolver, using
  official Simple Icons for supported services and Lucide icons for native
  tools and services without an available brand mark.
- Prominent segmented navigation uses a comfortable connected-tab treatment,
  and New Chat creates an isolated draft runtime instead of retaining the
  currently open conversation.
- The sidebar's Chat item is the single new-conversation action. Automation
  editing exposes time, weekday, interval, timezone, model-default, and title
  controls without requiring users to write cron expressions.

## Identity And Workspace Access

- Long-lived `brg_` API tokens are stored only as hashes, expire optionally,
  track last use, and can be created, listed, and revoked in web and CLI.
- Email-bound workspace invitations expire, can be revoked, use an injected
  mail driver when configured, and otherwise return a one-time share link.
- Invite links work for both new accounts and existing users without creating
  an unnecessary starter workspace for invited signups.
- Generic OpenID Connect SSO uses discovery, Authorization Code + PKCE S256,
  state, nonce, encrypted one-time state storage, verified email claims, and
  optional allowed-domain enforcement.
- The CLI exposes `bridge token list|create|revoke` and
  `bridge invite <email> [admin|member]` through the public API.

## Runtime And Security

- Approval requests receive a 24-hour default expiry. Expired requests become
  explicit denials, release the parked run, emit an audit event, and can be
  extended from the web queue before expiry.
- Workspace secrets may be bound into tool configuration only when the
  executing agent explicitly allows each named secret in its Manifest.
- Local installations can rotate the OS-stored master key while transactionally
  re-encrypting every saved secret and rolling the database back if key
  persistence fails.
- Long-term memory and curated knowledge are persisted per workspace and agent,
  injected into eligible runs, and inspectable through the public API and UI.
- Web search has workspace-scoped Brave Search and custom-endpoint drivers;
  credentials remain encrypted and are resolved only during tool execution.
- Streamed text deltas are persisted in `run_stream_events`, so an API process
  can stream output produced by a separate worker without requiring Redis.

## Channels And Dashboards

- Outbound adapter sends are serialized, rate-spaced, and retried with bounded
  exponential backoff.
- Telegram, Discord, and Slack remain operational; Matrix and Signal have
  native polling adapters, iMessage has a macOS Messages adapter, and WhatsApp
  has signed Meta webhook verification, inbound processing, and outbound Cloud
  API delivery.
- Channel credentials are encrypted workspace secrets and never embedded in a
  portable Manifest.
- Dashboards may now belong to the workspace as well as an individual agent,
  with the same schema validation, templates, rendering, and AI edit preview.
- Daily dashboard series use UTC consistently in SQL and empty buckets, so a
  host timezone cannot move today's activity into an invisible bucket.

## Schema And Verification

- Migration `0009_wonderful_franklin_richards.sql` adds the Phase 1-7 catch-up
  tables and approval expiry after the existing Phase 8 migration `0008`.
- Tenant and credential regression tests cover API-token revocation, invited
  signup, invitation isolation, encrypted search configuration, memory and
  workspace-dashboard isolation, approval expiry, secret grants, key rotation,
  and reliable channel delivery.

## Deliberate External Gates

- Hosted invitation email still requires an outbound mail driver and delivery
  credentials; self-hosted/community mode returns a usable share link.
- OIDC requires an operator-created identity-provider application and the
  `BRIDGE_OIDC_*` environment variables.
- WhatsApp, Signal, Matrix, and iMessage require their vendor account, host
  helper, OS permission, or public webhook prerequisites.
- Code signing, notarization, independent security review, and production
  container/microVM infrastructure require external credentials or authority
  and must not be described as completed by code alone.
- Phase 8 automation files are owned by the concurrent Claude effort and were
  intentionally not changed as part of this addendum.
