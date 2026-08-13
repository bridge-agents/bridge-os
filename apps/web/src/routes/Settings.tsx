import { Link } from "react-router-dom";
import { useSession } from "../session.jsx";
import { type ThemePreference, useTheme } from "../theme.jsx";
import { Badge, Button, Card, SectionHeader } from "../ui.jsx";

/**
 * Settings that belong to this install rather than to an agent. Appearance
 * lives here; credentials stay on Providers, where the secret store is.
 */
const APPEARANCES: { value: ThemePreference; label: string; hint: string }[] = [
  { value: "system", label: "System", hint: "Follow this device" },
  { value: "light", label: "Light", hint: "Always light" },
  { value: "dark", label: "Dark", hint: "Always dark" },
];

export function Settings() {
  const { preference, setPreference } = useTheme();
  const { user, workspace, signOut } = useSession();

  // Local installs have no account to sign out of (ADR-0014).
  const isLocal = user?.email.endsWith("@local.bridge") ?? false;

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <SectionHeader
          title="Appearance"
          description="Applies everywhere in Bridge and is remembered on this device."
        />

        <Card className="flex flex-wrap gap-2">
          {APPEARANCES.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setPreference(option.value)}
              aria-pressed={preference === option.value}
              className={`flex flex-col items-start gap-0.5 rounded-[var(--radius-sm)] border px-3 py-2 text-left transition ${
                preference === option.value
                  ? "border-border-strong bg-bg-overlay text-text"
                  : "border-border text-text-muted hover:border-border-strong hover:text-text"
              }`}
            >
              <span className="font-condensed text-sm font-semibold uppercase tracking-[0.06em]">
                {option.label}
              </span>
              <span className="text-xs text-text-faint">{option.hint}</span>
            </button>
          ))}
        </Card>
      </section>

      <section className="flex flex-col gap-3">
        <SectionHeader title="Workspace" />
        <Card className="flex flex-col gap-2 text-sm">
          <div className="flex justify-between gap-4">
            <span className="text-text-muted">Name</span>
            <span>{workspace?.name}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-text-muted">Signed in as</span>
            <span className="font-mono text-xs">{user?.email}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-text-muted">Mode</span>
            <Badge tone={isLocal ? "success" : "neutral"}>
              {isLocal ? "local · this device" : "server account"}
            </Badge>
          </div>
        </Card>
      </section>

      <section className="flex flex-col gap-3">
        <SectionHeader title="Model providers" />
        <Card className="flex items-center justify-between gap-4">
          <p className="text-sm text-text-muted">
            API keys, local endpoints and workspace secrets are managed on the Providers page.
          </p>
          <Link
            to="/providers"
            className="shrink-0 rounded-[var(--radius-sm)] border border-border px-3 py-1.5 text-sm transition hover:border-border-strong hover:bg-bg-overlay"
          >
            Open
          </Link>
        </Card>
      </section>

      {!isLocal && (
        <section className="flex flex-col gap-3">
          <SectionHeader title="Session" />
          <div>
            <Button variant="ghost" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
