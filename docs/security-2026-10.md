# October 2026 security maintenance

Development and CI use Node 24.22.1. Engines also permit patched Node 22.23.4
and 26.12.1 release lines and later patches. See the
[October 21 Node advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases).

The owner explicitly selected **Electron 46.0.0-alpha.1** to obtain its patched
Node 24.22.1. Stable Electron releases still use Node 24.22.0 at this review.
This is an intentionally prerelease desktop build, version 0.1.1-alpha.1;
compatibility risk remains until a supported stable Electron incorporates the fixes.
The installed Electron binary was queried directly to verify its Node version.

Renderer links allow only HTTP, HTTPS and mailto. In-app navigation requires
the exact application origin, rejecting credentials and prefix lookalikes.
The renderer explicitly enables Chromium's sandbox. The placeholder update
host was removed; packaged builds do not contact an update service unless an
owner-configured app-update.yml exists. Install this alpha manually.

## Dependency follow-up on 24 October

- Happy DOM is upgraded to 21.0.4 for the newly published host-code-execution fix.
- The Drizzle legacy loader resolves esbuild 0.25.12 through a scoped override.
  Its real CLI successfully generates the existing PostgreSQL schema into an
  isolated output directory; no database migration is applied by that check.
- GitHub withdrew GHSA-vfj7-8cjw-p6xm for braces on 23 October as not
  practically exploitable. It is no longer counted as an active vulnerability.

Validation: all 661 tests, lint, type checking and application builds pass.
The updated Happy DOM web tests and types also pass. A new OSV scan of the
changed lockfile reports no active matches. This describes known dependency
advisories, not a guarantee against every possible application vulnerability.

Apple Silicon macOS ZIP and DMG artifacts are built locally. The DMG is created
with macOS hdiutil because the bundled dmgbuild Python fails to import encodings
on this machine. The build is not notarized; other platforms have not been
packaged or smoke-tested in this pass.
