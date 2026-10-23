const EXTERNAL_PROTOCOLS = new Set(["https:", "http:", "mailto:"]);

/** Renderer links must never launch local files or arbitrary OS protocol handlers. */
export function externalLink(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!EXTERNAL_PROTOCOLS.has(url.protocol) || url.username || url.password) return;

    return url.href;
  } catch {
    return;
  }
}

/** Compare origins, not string prefixes such as https://bridge.example.attacker.test. */
export function isAppNavigation(value: string, appUrl: string | undefined): boolean {
  if (!appUrl) return false;

  try {
    const target = new URL(value);
    const app = new URL(appUrl);

    return (
      (target.protocol === "http:" || target.protocol === "https:") &&
      target.origin === app.origin &&
      !target.username &&
      !target.password
    );
  } catch {
    return false;
  }
}
