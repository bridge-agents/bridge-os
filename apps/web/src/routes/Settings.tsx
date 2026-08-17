import {
  Building2,
  Check,
  Laptop,
  LogOut,
  Moon,
  Palette,
  Save,
  Sun,
  UserRound,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { api, BridgeApiError, type ProviderModel } from "../api.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card.js";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs.js";
import { Textarea } from "../components/ui/textarea.js";
import { NavArtwork } from "../NavArtwork.jsx";
import { useSession } from "../session.jsx";
import { type AccentPreset, type ThemePreference, useTheme } from "../theme.jsx";
import { ErrorText, Field, Input, SectionHeader } from "../ui.jsx";
import { ProviderSettings } from "./Providers.jsx";
import { AccessSettings, SearchSettings } from "./SettingsOperations.jsx";
import { ToolSettings } from "./SettingsTools.jsx";

const APPEARANCES: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "System", icon: Laptop },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

const ACCENTS: { value: AccentPreset; label: string; swatch: string }[] = [
  {
    value: "metallic",
    label: "Metallic",
    swatch: "bg-gradient-to-br from-zinc-300 via-zinc-700 to-black",
  },
  { value: "blue", label: "Cobalt", swatch: "bg-blue-600" },
  { value: "violet", label: "Violet", swatch: "bg-violet-600" },
  { value: "amber", label: "Amber", swatch: "bg-amber-600" },
];

/**
 * Every zone this browser knows, which is the same list Node validates
 * against on the server — so a choice offered here can never be rejected
 * there.
 */
const timezones: string[] =
  typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
const detectedZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function Settings() {
  const { preference, setPreference, accent, customAccent, setAccent, setCustomAccent } =
    useTheme();
  const { user, workspace, refresh, signOut } = useSession();
  const [workspaceName, setWorkspaceName] = useState(workspace?.name ?? "");
  const [workspaceDescription, setWorkspaceDescription] = useState(workspace?.description ?? "");
  const [timezone, setTimezone] = useState(workspace?.timezone ?? "");
  const [defaultModel, setDefaultModel] = useState(
    workspace?.defaultModel
      ? `${workspace.defaultModel.provider}/${workspace.defaultModel.model}`
      : "",
  );
  const [defaultReasoning, setDefaultReasoning] = useState(workspace?.defaultReasoning ?? "");
  const [allowedPaths, setAllowedPaths] = useState<string[]>(workspace?.allowedPaths ?? []);
  const [newPath, setNewPath] = useState("");
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const isLocal = user?.email.endsWith("@local.bridge") ?? false;
  const canEditWorkspace = workspace?.role === "owner" || workspace?.role === "admin";

  useEffect(() => {
    setWorkspaceName(workspace?.name ?? "");
    setWorkspaceDescription(workspace?.description ?? "");
    setTimezone(workspace?.timezone ?? "");
    setDefaultModel(
      workspace?.defaultModel
        ? `${workspace.defaultModel.provider}/${workspace.defaultModel.model}`
        : "",
    );
    setDefaultReasoning(workspace?.defaultReasoning ?? "");
    setAllowedPaths(workspace?.allowedPaths ?? []);
  }, [
    workspace?.name,
    workspace?.description,
    workspace?.timezone,
    workspace?.defaultModel,
    workspace?.defaultReasoning,
    workspace?.allowedPaths,
  ]);

  useEffect(() => {
    if (!workspace) return;
    void api
      .providerModels(workspace.id)
      .then(({ models: available }) => setModels(available))
      .catch(() => setModels([]));
  }, [workspace]);

  const saveWorkspace = async (event: FormEvent) => {
    event.preventDefault();
    if (!workspace || !canEditWorkspace || !workspaceName.trim()) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const [provider, ...rest] = defaultModel.split("/");
      await api.updateWorkspace(workspace.id, {
        name: workspaceName.trim(),
        description: workspaceDescription.trim() || null,
        timezone: timezone || null,
        defaultModel: defaultModel && provider ? { provider, model: rest.join("/") } : null,
        defaultReasoning: defaultReasoning || null,
        allowedPaths,
      });
      await refresh();
      setSaved(true);
    } catch (cause) {
      setError(
        cause instanceof BridgeApiError
          ? cause.error.message
          : "Could not save workspace settings.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex w-full flex-col gap-8">
      <section className="space-y-4">
        <SectionHeader title="Appearance" description="Choose how Bridge appears on this device." />
        <Card className="rounded-lg">
          <CardHeader>
            <CardTitle>Color theme</CardTitle>
            <CardDescription>System follows your operating system automatically.</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs
              value={preference}
              onValueChange={(value) => setPreference(value as ThemePreference)}
            >
              <TabsList className="grid w-full max-w-md grid-cols-3">
                {APPEARANCES.map((option) => {
                  const Icon = option.icon;
                  return (
                    <TabsTrigger key={option.value} value={option.value}>
                      <Icon /> {option.label}
                    </TabsTrigger>
                  );
                })}
              </TabsList>
            </Tabs>
          </CardContent>
        </Card>
        <Card className="rounded-lg">
          <CardHeader>
            <span className="mb-2 flex size-9 items-center justify-center rounded-lg bg-accent text-accent-foreground">
              <Palette className="size-4" />
            </span>
            <CardTitle>Accent color</CardTitle>
            <CardDescription>
              Metallic is the Bridge default. This preference is saved on this device.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {ACCENTS.map((option) => (
              <Button
                key={option.value}
                type="button"
                variant={accent === option.value ? "secondary" : "outline"}
                onClick={() => setAccent(option.value)}
                aria-pressed={accent === option.value}
              >
                <span className={`size-4 rounded-sm border border-black/10 ${option.swatch}`} />
                {option.label}
                {accent === option.value && <Check className="ml-auto" />}
              </Button>
            ))}
            <label className="relative inline-flex h-8 cursor-pointer items-center gap-2 rounded-lg border border-input px-2.5 text-sm font-medium hover:bg-muted">
              <input
                type="color"
                value={customAccent}
                onChange={(event) => setCustomAccent(event.target.value)}
                className="absolute inset-0 cursor-pointer opacity-0"
                aria-label="Choose a custom accent color"
              />
              <span
                className="size-4 rounded-sm border"
                style={{ backgroundColor: customAccent }}
              />
              Custom
              {accent === "custom" && <Check className="size-4" />}
            </label>
          </CardContent>
        </Card>
      </section>

      <section className="space-y-4">
        <SectionHeader
          title="Workspace"
          description="Account and workspace context for this Bridge installation."
        />
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.65fr)]">
          <Card className="rounded-lg">
            <CardHeader>
              <span className="mb-2 flex size-9 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                <Building2 className="size-4" />
              </span>
              <CardTitle>Workspace details</CardTitle>
              <CardDescription>
                Used throughout Bridge and shared with workspace members.
              </CardDescription>
              <CardAction>
                <Badge variant="outline">{workspace?.role}</Badge>
              </CardAction>
            </CardHeader>
            <CardContent>
              <form onSubmit={saveWorkspace} className="space-y-4">
                <Field label="Workspace name">
                  {(id) => (
                    <Input
                      id={id}
                      value={workspaceName}
                      onChange={(event) => setWorkspaceName(event.target.value)}
                      maxLength={120}
                      disabled={!canEditWorkspace}
                    />
                  )}
                </Field>
                <Field label="Description" hint={`${workspaceDescription.length}/500`}>
                  {(id) => (
                    <Textarea
                      id={id}
                      value={workspaceDescription}
                      onChange={(event) => setWorkspaceDescription(event.target.value)}
                      maxLength={500}
                      rows={4}
                      disabled={!canEditWorkspace}
                      placeholder="Describe this workspace's team, purpose, or operating context."
                    />
                  )}
                </Field>
                <Field
                  label="Time zone"
                  hint="What “9am” means for schedules that do not name their own"
                >
                  {(id) => (
                    <select
                      id={id}
                      value={timezone}
                      onChange={(event) => setTimezone(event.target.value)}
                      disabled={!canEditWorkspace}
                      className="border-input bg-transparent focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-[3px] disabled:opacity-50"
                    >
                      <option value="">UTC (default)</option>
                      {/* Offered from the platform's own zone database, so the
                          list can never drift from what the server accepts. */}
                      {timezones.map((zone) => (
                        <option key={zone} value={zone}>
                          {zone.replace(/_/g, " ")}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                {detectedZone && detectedZone !== timezone && (
                  <button
                    type="button"
                    className="text-sm text-muted-foreground underline underline-offset-4"
                    onClick={() => setTimezone(detectedZone)}
                  >
                    Use this device's zone ({detectedZone.replace(/_/g, " ")})
                  </button>
                )}
                {/*
                  The model a run uses when nothing else says. The web
                  composer always sends one explicitly, which is why chat
                  worked while schedules and the CLI fell through to whatever
                  an agent's manifest happened to name.
                */}
                <Field label="Default model" hint="Used by schedules, the CLI, and new chats">
                  {(id) => (
                    <select
                      id={id}
                      value={defaultModel}
                      onChange={(event) => setDefaultModel(event.target.value)}
                      disabled={!canEditWorkspace}
                      className="border-input bg-transparent focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-[3px] disabled:opacity-50"
                    >
                      <option value="">Each agent's own model</option>
                      {models.map((model) => (
                        <option
                          key={`${model.provider}/${model.id}`}
                          value={`${model.provider}/${model.id}`}
                        >
                          {model.id} ({model.provider})
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <Field label="Default reasoning effort">
                  {(id) => (
                    <select
                      id={id}
                      value={defaultReasoning}
                      onChange={(event) => setDefaultReasoning(event.target.value)}
                      disabled={!canEditWorkspace}
                      className="border-input bg-transparent focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-[3px] disabled:opacity-50"
                    >
                      <option value="">Whatever the model does by default</option>
                      {["none", "low", "medium", "high", "xhigh", "max", "ultra"].map((level) => (
                        <option key={level} value={level}>
                          {level}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>

                {/*
                  Folders agents may work in. Machine paths do not belong in a
                  portable manifest, so they live on the workspace — and
                  naming them beats "full access", which is a shrug.
                */}
                <Field label="Folders agents can use" hint="Writing still asks first">
                  {(id) => (
                    <div className="flex flex-col gap-2">
                      {allowedPaths.map((path) => (
                        <div key={path} className="flex items-center gap-2">
                          <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-xs">
                            {path}
                          </code>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={!canEditWorkspace}
                            onClick={() =>
                              setAllowedPaths((current) =>
                                current.filter((entry) => entry !== path),
                              )
                            }
                          >
                            Remove
                          </Button>
                        </div>
                      ))}
                      <div className="flex gap-2">
                        <Input
                          id={id}
                          value={newPath}
                          onChange={(event) => setNewPath(event.target.value)}
                          placeholder="~/Downloads"
                          disabled={!canEditWorkspace}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          disabled={!canEditWorkspace || !newPath.trim()}
                          onClick={() => {
                            const value = newPath.trim();
                            setAllowedPaths((current) =>
                              current.includes(value) ? current : [...current, value],
                            );
                            setNewPath("");
                          }}
                        >
                          Add
                        </Button>
                      </div>
                    </div>
                  )}
                </Field>

                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="submit"
                    disabled={!canEditWorkspace || saving || !workspaceName.trim()}
                  >
                    <Save /> {saving ? "Saving" : "Save workspace"}
                  </Button>
                  {saved && (
                    <span className="text-sm text-muted-foreground">Workspace updated.</span>
                  )}
                  {!canEditWorkspace && (
                    <span className="text-sm text-muted-foreground">
                      Only owners and admins can edit workspace details.
                    </span>
                  )}
                </div>
                <ErrorText>{error}</ErrorText>
              </form>
            </CardContent>
          </Card>
          <Card className="rounded-lg">
            <CardHeader>
              <span className="mb-2 flex size-9 items-center justify-center rounded-lg bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300">
                <UserRound className="size-4" />
              </span>
              <CardTitle className="break-all text-sm">{user?.email}</CardTitle>
              <CardDescription>
                {isLocal ? "Local account on this device" : "Bridge server account"}
              </CardDescription>
              <CardAction>
                <Badge
                  className={
                    isLocal
                      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                      : undefined
                  }
                >
                  {isLocal ? "Local" : "Server"}
                </Badge>
              </CardAction>
            </CardHeader>
          </Card>
        </div>
      </section>

      <AccessSettings isLocal={isLocal} />

      <SearchSettings />

      <ToolSettings />

      <section id="providers" className="scroll-mt-20 space-y-4">
        <SectionHeader
          title="Model providers"
          description="Manage subscription sessions, API providers, local endpoints, and encrypted workspace secrets."
          action={<NavArtwork name="providers" className="size-8" />}
        />
        <ProviderSettings />
      </section>

      {!isLocal && (
        <section className="space-y-4">
          <SectionHeader title="Session" />
          <Button variant="outline" onClick={() => void signOut()}>
            <LogOut /> Sign out
          </Button>
        </section>
      )}
    </div>
  );
}
