# ADR-0016: The OS credential store holds the master key

**Status:** Accepted
**Date:** 2026-08-14
**Refines:** ADR-0011 (secrets and no native dependencies)
**Amends:** `ROADMAP.md` Phase 7, which specified a keychain-backed `SecretStore`

## Context

Provider credentials are stored as AES-256-GCM ciphertext in the database and
decrypted at execution time by the runtime (ADR-0011). The key comes from
`BRIDGE_SECRET_KEY`, which an operator sets on a server.

A desktop install has no operator. Until now the local API generated an
**ephemeral key at boot** when the variable was unset, and logged a warning.
On a server that warning is read by someone. On a desktop nobody reads it, and
the consequence is severe and silent: connect Anthropic, quit Bridge, reopen
it, and every stored credential is undecryptable — a `TypeError` deep in a
run rather than an honest "please reconnect". Phase 7 cannot ship a
consumer install with that in it.

The roadmap's answer was a keychain-backed `SecretStore`: one credential-store
item per secret, replacing the encrypted rows on desktop.

## Decision

**The credential store holds one master key. The credentials stay encrypted
rows.**

- `loadOrCreateSecretKey` looks for `BRIDGE_SECRET_KEY` first (servers are
  unchanged and unaffected), then the OS credential store, then generates a
  key and stores it.
- Reached through the tools every OS already ships, so no native module and
  no compile step per platform per Node ABI:
  - macOS — `security`, the login Keychain
  - Linux — `secret-tool`, libsecret
  - Windows — DPAPI via PowerShell, which encrypts under the logged-in user
    account with a key the OS holds
- Where there is no credential store — a headless container, a Linux box with
  no session bus — Bridge writes an owner-only (0600) key file and **says so**
  in a startup warning. Refusing to start would be worse; pretending the key
  is protected would be dishonest.
- A key found in that fallback file is moved into the credential store as soon
  as one is available, and only deleted from disk after the store reads it
  back. Losing this key loses every stored credential.

### Why one key rather than one item per secret

Against the threat that matters here — someone reading the application-data
directory, a stolen backup, a synced folder — both designs are equally
effective: the ciphertext is useless without a key the OS holds. What differs
is cost.

One item is read once at boot. One item *per secret* is a subprocess spawn
per credential per agent run, on the hot path of every tool call. It would
also fork `SecretStore` into two implementations with different failure
modes, and put the workspace-scoping rules — which are a security boundary
with their own tests — into the one that has no database to enforce them.

The honest limit of both designs is the same: any process running as this
user can ask the credential store, exactly as it could ask for the user's
shell history or browser profile. macOS per-item ACLs do not change that
when the reader is `/usr/bin/security`.

## Consequences

**Good.** Restarting Bridge no longer orphans credentials — the bug this
exists to close. Nothing is written to disk in plaintext. `SecretStore` keeps
one implementation, so workspace scoping and its isolation tests stay in one
place. Servers and Cloud are untouched.

**Cost.** A credential-store round trip at boot, and a startup path that has
to degrade rather than fail. A user who erases their keychain item loses their
saved provider keys and must reconnect — the same as losing
`BRIDGE_SECRET_KEY` on a server, which is why the app reports where the key
is kept rather than leaving it invisible.

**Deferred.** Per-secret items, if per-item ACLs or per-agent credential
scoping ever earn them; the seam is `loadOrCreateSecretKey` plus the
`SecretStore` interface, both already in place. Key rotation remains manual
and undocumented for desktop, as it is for servers.
