import bridgeMark from "@bridge/ui/assets/bridge-icon-transparent.png";
import { type FormEvent, useState } from "react";
import { api, BridgeApiError } from "../api.js";
import { useSession } from "../session.jsx";
import { Button, ErrorText, Field, Input } from "../ui.jsx";

export function SignIn() {
  const { refresh } = useSession();
  const [mode, setMode] = useState<"signin" | "signup">("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "signup") await api.signup(email, password);
      else await api.login(email, password);
      await refresh();
    } catch (err) {
      setError(
        err instanceof BridgeApiError
          ? (err.error.details?.[0]?.message ?? err.error.message)
          : "Something went wrong. Is the Bridge API running?",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col items-center gap-3">
          {/* Square, not cropped: a round mask cuts the deck off at both ends. */}
          <img src={bridgeMark} alt="" className="h-16 w-16 object-contain" />
          <div className="flex flex-col items-center gap-1 text-center">
            <h1 className="font-condensed text-2xl font-semibold uppercase tracking-[0.16em]">
              Bridge
            </h1>
            <span className="dimension w-24" aria-hidden="true" />
            <p className="mt-1 text-sm text-text-muted">
              {mode === "signup" ? "Create your workspace" : "Welcome back"}
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <Field label="Email">
            {(id) => (
              <Input
                id={id}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
            )}
          </Field>
          <Field label="Password" hint={mode === "signup" ? "At least 12 characters." : undefined}>
            {(id) => (
              <Input
                id={id}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                required
              />
            )}
          </Field>
          <ErrorText>{error}</ErrorText>
        </div>

        <div className="flex flex-col gap-3">
          <Button type="submit" disabled={busy}>
            {busy ? "Working…" : mode === "signup" ? "Create account" : "Sign in"}
          </Button>
          <button
            type="button"
            className="text-xs text-text-muted underline-offset-4 hover:underline"
            onClick={() => {
              setMode(mode === "signup" ? "signin" : "signup");
              setError(null);
            }}
          >
            {mode === "signup" ? "I already have an account" : "Create an account instead"}
          </button>
        </div>
      </form>
    </main>
  );
}
