# October 2026 security maintenance

Use Node 24.22.1 for development and CI (`.node-version`). The engine range
also permits the patched 22.23.4 and 26.12.1 release lines and later patches.
These releases address the [October 21 Node security advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases).

The dependency refresh updates Hono, Vite, Vitest, Happy DOM, Electron and
affected transitive libraries. The desktop renderer may open only HTTP,
HTTPS and mailto links in the operating system. In-app navigation requires
the application's exact origin; prefix lookalikes and URLs containing
credentials are rejected. The renderer explicitly enables Chromium's sandbox.

## Remaining dependencies requiring follow-up

- **Electron's bundled Node remains behind the security release.** Electron
  43.8.3 includes Node 24.22.0. Updating the system's Node does not update the
  runtime bundled in Electron or the API process launched through it. Adopt
  an Electron release containing the Node fixes when the vendor publishes it.
  This update must not be described as resolving every Node vulnerability.
- **braces 3.0.3** remains in the development-only shadcn CLI dependency tree.
  GHSA-vfj7-8cjw-p6xm currently has no patched release. Do not pass untrusted
  glob patterns to that tool.
- **esbuild 0.18.20** remains under Drizzle Kit's legacy loader. Its advisory
  concerns serving content through the development server. Application builds
  use a separate patched esbuild; do not expose Drizzle tooling to the network.
  Removing the legacy loader requires an upstream Drizzle Kit update.

Validation: all 661 tests, lint, type checking and the web/API/CLI build pass
on Node 24.22.1. A fresh OSV scan of the lockfile reports only the braces and
legacy esbuild findings above; OSV package checks do not inspect Electron's
embedded Node binary.
