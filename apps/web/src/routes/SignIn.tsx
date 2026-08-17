import bridgeMark from "@bridge/ui/assets/bridge-icon-transparent.png";
import {
  ArrowRight,
  Building2,
  Loader2,
  LockKeyhole,
  Mail,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, BridgeApiError } from "../api.js";
import { Button } from "../components/ui/button.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card.js";
import { Separator } from "../components/ui/separator.js";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs.js";
import { useSession } from "../session.jsx";
import { ErrorText, Field, Input } from "../ui.jsx";

export function SignIn() {
  const { refresh } = useSession();
  const [params] = useSearchParams();
  const invitationToken = params.get("invite") ?? undefined;
  const [mode, setMode] = useState<"signin" | "signup">("signup");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [invitation, setInvitation] = useState<{
    email: string;
    role: string;
    workspaceName: string;
  } | null>(null);
  const [sso, setSso] = useState<{ enabled: boolean; name?: string }>({ enabled: false });

  useEffect(() => {
    if (!invitationToken) return;
    void api.invitation(invitationToken).then(
      ({ invitation: value }) => {
        setInvitation(value);
        setEmail(value.email);
      },
      () => setError("This workspace invitation is invalid or has expired."),
    );
  }, [invitationToken]);

  useEffect(() => {
    void api.sso().then(
      ({ sso: value }) => setSso(value),
      () => undefined,
    );
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "signup") {
        await api.signup(email, password, name.trim() || undefined, invitationToken);
      } else {
        await api.login(email, password);
        if (invitationToken) await api.acceptInvitation(invitationToken);
      }
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof BridgeApiError
          ? (cause.error.details?.[0]?.message ?? cause.error.message)
          : "Something went wrong. Check that the Bridge API is running.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="grid min-h-screen place-items-center overflow-y-auto bg-muted/25 p-4 sm:p-8">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-3">
          <img src={bridgeMark} alt="Bridge" className="size-11 object-contain" />
          <div>
            <h1 className="text-lg font-semibold">Bridge</h1>
            <p className="text-xs text-muted-foreground">Agent operations platform</p>
          </div>
        </div>

        <Card className="rounded-lg shadow-lg">
          <CardHeader>
            <CardTitle>
              {mode === "signup" ? "Create your workspace" : "Sign in to Bridge"}
            </CardTitle>
            <CardDescription>
              {mode === "signup"
                ? "Set up your account to build and operate agents."
                : "Continue to your agents, chats, and dashboards."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {invitation && (
              <div className="mb-5 flex items-start gap-3 rounded-md border bg-muted/40 p-3 text-sm">
                <Building2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div>
                  <p className="font-medium">Join {invitation.workspaceName}</p>
                  <p className="text-muted-foreground">
                    Continue as {invitation.email} with the {invitation.role} role.
                  </p>
                </div>
              </div>
            )}
            <Tabs
              value={mode}
              onValueChange={(value) => {
                setMode(value as "signin" | "signup");
                setError(null);
              }}
              className="mb-5"
            >
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="signup">Create account</TabsTrigger>
                <TabsTrigger value="signin">Sign in</TabsTrigger>
              </TabsList>
            </Tabs>

            <form onSubmit={submit} className="space-y-4">
              {mode === "signup" && (
                <Field label="Name">
                  {(id) => (
                    <div className="relative">
                      <UserRound className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id={id}
                        className="pl-8"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        autoComplete="name"
                        placeholder="Your name"
                      />
                    </div>
                  )}
                </Field>
              )}
              <Field label="Email">
                {(id) => (
                  <div className="relative">
                    <Mail className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id={id}
                      className="pl-8"
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      autoComplete="email"
                      required
                      readOnly={Boolean(invitation)}
                      placeholder="you@company.com"
                    />
                  </div>
                )}
              </Field>
              <Field
                label="Password"
                hint={mode === "signup" ? "Use at least 12 characters." : undefined}
              >
                {(id) => (
                  <div className="relative">
                    <LockKeyhole className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id={id}
                      className="pl-8"
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete={mode === "signup" ? "new-password" : "current-password"}
                      required
                    />
                  </div>
                )}
              </Field>
              <ErrorText>{error}</ErrorText>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? <Loader2 className="animate-spin" /> : <ArrowRight />}
                {busy ? "Working" : mode === "signup" ? "Create workspace" : "Sign in"}
              </Button>
            </form>
            {sso.enabled && (
              <div className="mt-5 space-y-4">
                <div className="flex items-center gap-3">
                  <Separator className="flex-1" />
                  <span className="text-xs text-muted-foreground">or</span>
                  <Separator className="flex-1" />
                </div>
                <Button asChild variant="outline" className="w-full">
                  <a href="/api/v1/auth/sso/start">
                    <ShieldCheck /> Continue with {sso.name ?? "company SSO"}
                  </a>
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
        <p className="mt-4 text-center text-xs text-muted-foreground">
          Credentials are sent only to your configured Bridge API.
        </p>
      </div>
    </main>
  );
}
