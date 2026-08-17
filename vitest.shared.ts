/**
 * Timeouts for suites that stand up real infrastructure per test.
 *
 * Several packages create an embedded Postgres and run every migration in
 * `beforeEach`, and some hash passwords with OWASP scrypt parameters. That is
 * deliberate — those tests are worth having precisely because nothing about
 * them is mocked — but Turborepo runs fourteen packages at once, and under
 * that load vitest's 10s default measures how busy the machine is rather than
 * whether the code works. A timeout there reads as a failure in the code,
 * which is the worst kind of flake: it sends you looking in the wrong place.
 *
 * ponytail: the real fix is one database per file with truncation between
 * tests, trading per-test isolation for speed. Bigger than the flake
 * justifies today, and the isolation is worth something.
 */
export const infrastructureTimeouts = {
  hookTimeout: 60_000,
  testTimeout: 30_000,
} as const;
