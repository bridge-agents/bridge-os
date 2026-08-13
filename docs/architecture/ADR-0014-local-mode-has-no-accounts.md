# ADR-0014: Local mode has no accounts

**Status:** Accepted
**Date:** 2026-08-13
**Supersedes nothing. Refines:** ADR-0008 (deployment targets), ADR-0005 (API-first)

## Context

Bridge Community is a consumer application that runs on the user's own device
(ADR-0008). Until now every deployment target shared one authentication path:
sign up with an email and password, get a session, use it from every client.

On a desktop install that is theatre. The database is a file in the user's
home directory, the server is a process they started, and the only person who
can reach it is the person sitting at the machine. Asking them to invent a
password protects their data from nobody — they already have the file — and it
costs them a signup form, a forgotten-password path, and a reason to bounce
before ever meeting an agent. A first run should be "type `bridge`, answer two
questions, start talking", not "create an account".

Signing in still matters for a self-hosted server or Bridge Cloud, where more
than one person can reach the same install and the machine is not the
boundary.

## Decision

**Local mode has one owner, provisioned automatically, and no sign-in.**

- When the API starts against an embedded database, it runs in local mode
  (`BRIDGE_LOCAL_MODE` forces it either way).
- On first boot it creates one user (`you@local.bridge`, no password hash) and
  one workspace, then treats every request as that owner. The account has no
  password, so it cannot be logged into even if the database is copied to a
  server.
- **In local mode the server binds `127.0.0.1` only.** This is the boundary
  that replaces authentication: unauthenticated requests are safe precisely
  because nothing off-machine can make one.
- A stale or invalid token in local mode falls through to the local owner
  rather than returning 401 — a leftover token from a previous server login
  must not lock someone out of their own machine.
- Server and Cloud deployments are untouched: no `localUserId`, so
  `requireAuth` behaves exactly as before.

Everything below auth is unchanged. Workspace scoping still applies — the
local owner sees their workspace and nothing else — so the same isolation
tests cover both modes, and there is no second code path to keep honest.

## Consequences

**Good.** First run is one command. The consumer promise in ADR-0008 ("no
Docker, no terminal, no ports") extends to "no account". Cloud can add
identity providers later without local users ever noticing.

**Cost.** Any process on the machine can reach the API and act as the owner.
That is the same trust model as the user's own shell, editor, and browser
profile — but it means local mode must never be exposed beyond loopback, which
is why the bind address is part of the decision rather than a deployment
detail. If we ever want "expose my local Bridge to my LAN", that is not a flag
on local mode; it is server mode, with accounts.

**Deferred.** Desktop packaging (Phase 7) should move the local credential and
database out of the repo-relative path into an OS application-data directory,
and put secrets in the platform keychain (ADR-0011). None of that changes this
decision; it changes where the files live.
