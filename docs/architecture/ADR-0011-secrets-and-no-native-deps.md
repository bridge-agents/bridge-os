# ADR-0011: Secrets behind a store interface; stdlib crypto only, no native dependencies

Status: accepted (2026-08-12)

## Context
Bridge holds provider API keys. On a server they must be encrypted at rest;
on a desktop they should live in the OS credential store; in Cloud they
belong in a managed KMS. Separately, the desktop app has to package the whole
runtime for macOS, Windows and Linux — and native modules (argon2, libsodium,
better-sqlite3) are the usual reason cross-platform packaging and
auto-updates break.

## Decision
- A **`SecretStore` interface** (`put` / `list` / `reveal` / `delete`) is the
  only way credentials are stored or read. `EncryptedDbSecretStore`
  (AES-256-GCM, key from `BRIDGE_SECRET_KEY`) ships now; a keychain-backed
  store for desktop and a KMS-backed store for Cloud implement the same
  interface without touching callers.
- The API never returns a credential — only a reference and a masked hint
  (`sk-…f4a2`). Plaintext is resolved at execution time for one adapter call.
- **Node stdlib crypto only**: scrypt (OWASP parameters, stored per hash) for
  passwords, AES-256-GCM for secrets, SHA-256 for session/API token hashes,
  `randomBytes` for token generation. No native dependency anywhere in the
  runtime path.
- Session tokens are stored hashed, so a database leak yields no usable
  sessions. Cookie (browser) and bearer (CLI/desktop/mobile) resolve to the
  same session record.

## Consequences
- The desktop bundle stays pure JavaScript/WASM and is buildable for three
  platforms without per-OS native toolchains.
- scrypt is slower per login than argon2id at equivalent security; at ~200ms
  that is the correct trade for packaging simplicity, and the parameters are
  stored per hash so they can be raised without invalidating anything.
- Self-hosters must set `BRIDGE_SECRET_KEY` or stored credentials will not
  decrypt after a restart. The API refuses to start in production without it
  and warns loudly in development.
