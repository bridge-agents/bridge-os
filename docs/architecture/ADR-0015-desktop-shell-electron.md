# ADR-0015: The desktop shell is Electron, not Tauri

**Status:** Accepted
**Date:** 2026-08-14
**Reverses:** the Tauri preference recorded in `ROADMAP.md` Phase 7
**Refines:** ADR-0008 (deployment targets), ADR-0011 (no native dependencies)

## Context

Bridge Community is a consumer install: download, open, use — no Docker, no
terminal, no ports (ADR-0008). That needs a native shell around the web
client, and the roadmap wrote down a preference for **Tauri**, on the grounds
that it produces a small bundle and uses the system webview instead of
shipping Chromium.

That reasoning holds for an app whose backend is Rust or whose frontend is
self-contained. Bridge is neither. The thing being packaged is a **Node
server**: the API hosts the agent runtime in-process, the database is Postgres
compiled to WebAssembly running inside that process, and the whole runtime is
JavaScript by deliberate decision (ADR-0011, no native dependencies).

So a Tauri build does not avoid shipping a runtime. It ships a Rust binary
*and* a Node runtime as a sidecar, and adds a second language, a second
toolchain, and an IPC boundary between them — to save perhaps 50 MB against
an app that already carries a WASM Postgres. The bundle-size argument, which
was the whole case for Tauri, mostly evaporates once the sidecar is counted.

There is also a plain practical fact: Rust is not required anywhere else in
this project, so choosing Tauri means every contributor and every CI runner
installs a toolchain used by one directory.

## Decision

**The desktop shell is Electron, and the app runs the API as a child process
of its own binary.**

- Electron's binary is also a Node runtime (`ELECTRON_RUN_AS_NODE=1`), so the
  app ships **one** runtime, not a shell plus a sidecar. The supervisor
  spawns `process.execPath` and gets Node.
- The API is bundled to a single file with esbuild rather than compiled per
  package, because every workspace package exports TypeScript directly. Only
  the dependencies that read files relative to themselves stay external —
  PGlite's WASM, pino's transports.
- The window loads `http://127.0.0.1:<port>` — the same HTTP application a
  browser would load — with `nodeIntegration` off and `contextIsolation` on.
  There is no preload API and no privileged channel into the page.
- `electron-builder` produces the three platform artifacts from one config.

The window being a real browser view onto a real server is the part worth
protecting: it is what keeps local, self-hosted and Cloud the same product
rather than three codebases. Pointing the app at a different Bridge changes
the URL and nothing else.

## Consequences

**Good.** One language, one toolchain, one runtime in the bundle. The shell
is thin enough to be honest about — supervision, tray, menus, notifications,
deep links, updates — with no product logic in it. `electron-builder` covers
signing, notarisation and the update feed as configuration.

**Cost.** The download is roughly 100 MB rather than roughly 50 MB, and
Bridge inherits Chromium's update treadmill: a Chromium security release
means shipping a Bridge release. That is a real recurring obligation and the
main thing to weigh if this is ever revisited.

**Not weakened.** ADR-0011 still holds — nothing here adds a native module,
which is precisely why one bundle runs on three platforms.

**Reversible.** The supervisor imports nothing from Electron, and the window
loads a URL. Swapping the shell means rewriting `main.ts`; the runtime, the
API and the client are untouched. That is the seam to use if the Chromium
cost ever outgrows the toolchain cost.
