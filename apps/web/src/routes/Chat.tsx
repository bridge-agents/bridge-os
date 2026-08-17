import {
  AssistantRuntimeProvider,
  type AttachmentAdapter,
  type ChatModelAdapter,
  type CompleteAttachment,
  type ThreadAssistantMessagePart,
  type ThreadMessageLike,
  useLocalRuntime,
} from "@assistant-ui/react";
import {
  AlertCircle,
  BrainCircuit,
  Check,
  ChevronsUpDown,
  CirclePlus,
  Gauge,
  Loader2,
  Sparkles,
  Zap,
} from "lucide-react";
import { type ComponentType, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AgentArtwork } from "../AgentArtwork.jsx";
import {
  type AgentSummary,
  type Approval,
  api,
  BridgeApiError,
  type Attachment as BridgeAttachment,
  type ConversationRun,
  type ProviderModel,
  type ReasoningEffort,
} from "../api.js";
import { chatSessionKey, newChatParams } from "../chatNavigation.js";
import { CommandLayer } from "../commands/CommandLayer.jsx";
import { Thread } from "../components/assistant-ui/thread.js";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert.js";
import { Button } from "../components/ui/button.js";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../components/ui/command.js";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Switch } from "../components/ui/switch.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip.js";
import { ProviderLogo } from "../ProviderLogo.jsx";
import { useWorkspaceId } from "../session.jsx";
import { ToolIcon } from "../ToolIcon.jsx";

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: "No reasoning",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

const modelKey = (model: ProviderModel) => `${model.provider}:${model.id}`;

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof BridgeApiError ? error.error.message : fallback;

const attachmentUrl = (workspaceId: string, attachmentId: string) =>
  new URL(
    `/api/v1/workspaces/${workspaceId}/attachments/${attachmentId}`,
    window.location.origin,
  ).toString();

const bridgeAttachment = (
  workspaceId: string,
  attachment: BridgeAttachment,
): CompleteAttachment => ({
  id: attachment.id,
  type: attachment.mimeType.startsWith("image/") ? "image" : "document",
  name: attachment.name,
  contentType: attachment.mimeType,
  status: { type: "complete" },
  content: attachment.mimeType.startsWith("image/")
    ? [
        {
          type: "image",
          image: attachmentUrl(workspaceId, attachment.id),
          filename: attachment.name,
        },
      ]
    : [
        {
          type: "file",
          filename: attachment.name,
          data: attachmentUrl(workspaceId, attachment.id),
          mimeType: attachment.mimeType,
          sourceType: "url",
        },
      ],
});

const generatedAttachmentPart = (
  workspaceId: string,
  attachment: BridgeAttachment,
): ThreadAssistantMessagePart =>
  attachment.mimeType.startsWith("image/")
    ? {
        type: "image",
        image: attachmentUrl(workspaceId, attachment.id),
        filename: attachment.name,
      }
    : {
        type: "file",
        filename: attachment.name,
        data: attachmentUrl(workspaceId, attachment.id),
        mimeType: attachment.mimeType,
        sourceType: "url",
      };

function initialMessages(
  workspaceId: string,
  messages: {
    id: string;
    runId: string | null;
    role: string;
    content: string;
    attachments: BridgeAttachment[];
  }[],
  runs: ConversationRun[] = [],
): ThreadMessageLike[] {
  const rendered = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => {
      if (message.role === "assistant") {
        return {
          id: message.id,
          role: "assistant" as const,
          content: [
            ...(message.content ? ([{ type: "text", text: message.content }] as const) : []),
            ...message.attachments.map((attachment) =>
              generatedAttachmentPart(workspaceId, attachment),
            ),
          ],
        };
      }
      return {
        id: message.id,
        role: "user" as const,
        content: message.content,
        ...(message.attachments.length
          ? {
              attachments: message.attachments.map((attachment) =>
                bridgeAttachment(workspaceId, attachment),
              ),
            }
          : {}),
      };
    });

  /**
   * A run with no answer still has to say something.
   *
   * Runs that failed, were cancelled, or are still going never write an
   * assistant message. Without a note here the conversation shows the
   * question and then nothing — which reads as an agent that ignored you,
   * and for a scheduled run that crashed at 3am, as if it never ran at all.
   */
  const answered = new Set(
    messages.filter((message) => message.role === "assistant").map((message) => message.runId),
  );
  const notes = runs
    .filter((run) => !answered.has(run.id))
    .map(
      (run): ThreadMessageLike => ({
        id: `outcome-${run.id}`,
        role: "assistant",
        content: [{ type: "text", text: outcomeText(run) }],
      }),
    );

  return [...rendered, ...notes];
}

/**
 * The one detail that decides an approval: which file, which URL, which
 * command. "wants to write" is not something anyone can say yes to.
 */
function approvalTarget(approval: Approval): string {
  const input = approval.input ?? {};
  for (const key of ["path", "url", "command", "to", "query"]) {
    const value = input[key];
    if (typeof value === "string" && value) {
      return key === "command"
        ? [value, ...(Array.isArray(input.args) ? input.args.map(String) : [])].join(" ")
        : value;
    }
  }
  return "";
}

/** Plain words for a run that produced no reply. */
function outcomeText(run: ConversationRun): string {
  switch (run.status) {
    case "failed":
      return `**This run failed.**\n\n${run.error ?? "No reason was recorded."}`;
    case "cancelled":
      return "**This run was cancelled.**";
    case "waiting_approval":
      return "**Waiting for your approval.** Decide above and the run picks up where it stopped.";
    case "running":
      return "_Working…_";
    default:
      return "_Queued — waiting for a runner._";
  }
}

interface RuntimeProps {
  workspaceId: string;
  agentId: string;
  conversationId?: string;
  messages: ThreadMessageLike[];
  selectedModel?: ProviderModel;
  reasoning?: ReasoningEffort;
  fastMode: boolean;
  onConversationCreated: (conversationId: string) => void;
  onWaitingApproval: () => void;
  ComposerControls: ComponentType;
  Welcome: ComponentType;
}

function BridgeAssistantRuntime({
  workspaceId,
  agentId,
  conversationId,
  messages,
  selectedModel,
  reasoning,
  fastMode,
  onConversationCreated,
  onWaitingApproval,
  ComposerControls,
  Welcome,
}: RuntimeProps) {
  const activeConversation = useRef(conversationId);
  activeConversation.current = conversationId;

  const attachmentAdapter = useMemo<AttachmentAdapter>(() => {
    let composerAttachmentCount = 0;
    return {
      accept:
        "image/*,application/pdf,text/*,application/json,.md,.csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx",
      async add({ file }) {
        if (composerAttachmentCount >= 10) {
          throw new Error("You can attach up to 10 files to one message.");
        }
        composerAttachmentCount += 1;
        try {
          const { attachment } = await api.uploadAttachment(workspaceId, file);
          return {
            id: attachment.id,
            type: file.type.startsWith("image/") ? "image" : "document",
            name: attachment.name,
            contentType: attachment.mimeType,
            file,
            status: { type: "requires-action", reason: "composer-send" },
          };
        } catch (error) {
          composerAttachmentCount -= 1;
          throw error;
        }
      },
      async remove(attachment) {
        composerAttachmentCount = Math.max(0, composerAttachmentCount - 1);
        await api.deleteAttachment(workspaceId, attachment.id).catch(() => undefined);
      },
      async send(attachment) {
        composerAttachmentCount = Math.max(0, composerAttachmentCount - 1);
        const data = attachmentUrl(workspaceId, attachment.id);
        return {
          ...attachment,
          status: { type: "complete" },
          content:
            attachment.type === "image"
              ? [{ type: "image", image: data, filename: attachment.name }]
              : [
                  {
                    type: "file",
                    filename: attachment.name,
                    data,
                    mimeType: attachment.contentType || "application/octet-stream",
                    sourceType: "url",
                  },
                ],
        };
      },
    };
  }, [workspaceId]);

  const chatModel = useMemo<ChatModelAdapter>(
    () => ({
      async *run({ messages: runtimeMessages, abortSignal }) {
        const userMessage = [...runtimeMessages]
          .reverse()
          .find((message) => message.role === "user");
        if (!userMessage) throw new Error("A user message is required to start a run.");

        const input = userMessage.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
          .trim();
        const attachmentIds = userMessage.attachments.map((attachment) => attachment.id);
        const { run } = await api.startRun(workspaceId, agentId, input, {
          ...(activeConversation.current ? { conversationId: activeConversation.current } : {}),
          ...(attachmentIds.length ? { attachmentIds } : {}),
          ...(selectedModel
            ? { model: { provider: selectedModel.provider, model: selectedModel.id } }
            : {}),
          ...(reasoning ? { reasoningEffort: reasoning } : {}),
          fastMode,
        });
        activeConversation.current = run.conversationId;

        const parts: ThreadAssistantMessagePart[] = [];
        const generatedParts: ThreadAssistantMessagePart[] = [];
        let text = "";
        let stepIndex = 0;
        let terminalStatus = "succeeded";

        const currentContent = () => [
          ...parts,
          ...(text ? ([{ type: "text", text }] as const) : []),
          ...generatedParts,
        ];

        try {
          for await (const event of api.runStream(workspaceId, run.id, abortSignal)) {
            if (event.type === "delta") {
              text += event.text;
              yield { content: currentContent() };
              continue;
            }

            if (event.type === "step") {
              const data = event.step.data as Record<string, unknown>;
              if (event.step.type === "tool_call") {
                parts.push({
                  type: "tool-call",
                  toolCallId: `${run.id}-tool-${stepIndex++}`,
                  toolName: String(data.tool ?? "tool"),
                  args:
                    data.arguments && typeof data.arguments === "object"
                      ? (JSON.parse(JSON.stringify(data.arguments)) as never)
                      : {},
                  argsText: JSON.stringify(data.arguments ?? {}),
                  result: data.executed ? (data.output ?? data.error ?? null) : undefined,
                  isError: data.ok === false || Boolean(data.error),
                });
              } else if (event.step.type === "delegation") {
                parts.push({
                  type: "tool-call",
                  toolCallId: `${run.id}-delegation-${stepIndex++}`,
                  toolName: `Delegate to ${String(data.to ?? "agent")}`,
                  args: { task: String(data.task ?? "") },
                  argsText: JSON.stringify({ task: String(data.task ?? "") }),
                  result: data.result,
                });
              }
              yield { content: currentContent() };
              continue;
            }

            terminalStatus = event.status;
            if (!text && event.output?.content) {
              const terminalContent = event.output.content;
              const chunkSize = Math.max(6, Math.ceil(terminalContent.length / 48));
              for (let offset = 0; offset < terminalContent.length; offset += chunkSize) {
                if (abortSignal.aborted) throw new DOMException("Aborted", "AbortError");
                text += terminalContent.slice(offset, offset + chunkSize);
                yield { content: currentContent() };
                await new Promise<void>((resolve) => setTimeout(resolve, 16));
              }
            }
            for (const attachment of event.output?.attachments ?? []) {
              if (
                !generatedParts.some(
                  (part) =>
                    (part.type === "image" && part.image.includes(attachment.id)) ||
                    (part.type === "file" && part.data.includes(attachment.id)),
                )
              ) {
                generatedParts.push(generatedAttachmentPart(workspaceId, attachment));
              }
            }
          }
        } catch (error) {
          if (abortSignal.aborted) {
            await api.cancelRun(workspaceId, run.id).catch(() => undefined);
            yield {
              content: currentContent(),
              status: { type: "incomplete", reason: "cancelled" },
            };
            return;
          }
          throw error;
        }

        if (terminalStatus === "waiting_approval") onWaitingApproval();
        yield {
          content: currentContent(),
          status:
            terminalStatus === "succeeded"
              ? { type: "complete", reason: "stop" }
              : terminalStatus === "cancelled"
                ? { type: "incomplete", reason: "cancelled" }
                : terminalStatus === "waiting_approval"
                  ? { type: "complete", reason: "stop" }
                  : { type: "incomplete", reason: "other" },
        };

        if (conversationId !== run.conversationId) {
          queueMicrotask(() => onConversationCreated(run.conversationId));
        }
      },
    }),
    [
      agentId,
      conversationId,
      fastMode,
      onConversationCreated,
      onWaitingApproval,
      reasoning,
      selectedModel,
      workspaceId,
    ],
  );

  const runtime = useLocalRuntime(chatModel, {
    initialMessages: messages,
    adapters: { attachments: attachmentAdapter },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {/* Typing "/" in the composer runs Bridge commands rather than
          messaging the agent. */}
      <CommandLayer />
      <Thread components={{ ComposerControls, Welcome }} />
    </AssistantRuntimeProvider>
  );
}

function ChatLoading() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center gap-3 border-b px-5">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="ml-auto h-8 w-24" />
      </div>
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-end gap-4 p-6">
        <Skeleton className="h-20 w-2/3 self-end" />
        <Skeleton className="h-28 w-3/4" />
        <Skeleton className="h-28 w-full" />
      </div>
    </div>
  );
}

export function Chat() {
  const workspaceId = useWorkspaceId();
  const [params, setParams] = useSearchParams();
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [models, setModels] = useState<ProviderModel[] | null>(null);
  const [history, setHistory] = useState<ThreadMessageLike[] | null>(null);
  const [pending, setPending] = useState<Approval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [fallbackAgentId, setFallbackAgentId] = useState("");
  const [selectedModelKey, setSelectedModelKey] = useState("");
  const [reasoning, setReasoning] = useState<ReasoningEffort | "">("");
  const [fastMode, setFastMode] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [decidingApproval, setDecidingApproval] = useState<string | null>(null);

  const agentId = params.get("agent") ?? fallbackAgentId;
  const conversationId = params.get("conversation") ?? undefined;
  const activeChatSession = chatSessionKey(params);

  useEffect(() => {
    let cancelled = false;
    void api
      .agents(workspaceId)
      .then(({ agents: agentList }) => {
        if (cancelled) return;
        const deployed = agentList.filter((agent) => agent.status === "deployed");
        setAgents(agentList);
        setFallbackAgentId(deployed[0]?.id ?? "");
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(errorMessage(cause, "Could not load agents."));
        setAgents([]);
      });
    void api
      .providerModels(workspaceId)
      .then(({ models: modelList }) => {
        if (cancelled) return;
        setModels(modelList);
        setModelError(null);
      })
      .catch((cause) => {
        if (cancelled) return;
        setModelError(errorMessage(cause, "Could not load connected models."));
        setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    if (!agentId || !models?.length) return;
    let cancelled = false;
    void api
      .agent(workspaceId, agentId)
      .then(({ agent }) => {
        if (cancelled) return;
        const preferred = (
          agent.manifest.models as { default?: { provider?: string; model?: string } } | undefined
        )?.default;
        const selected =
          models.find(
            (model) => model.provider === preferred?.provider && model.id === preferred?.model,
          ) ?? models[0];
        if (!selected) return;
        setSelectedModelKey(modelKey(selected));
        setReasoning(
          selected.reasoningEfforts.includes("medium")
            ? "medium"
            : (selected.reasoningEfforts[0] ?? ""),
        );
        setFastMode(false);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [workspaceId, agentId, models]);

  useEffect(() => {
    let cancelled = false;
    if (activeChatSession.startsWith("draft:")) {
      setHistory([]);
      return () => {
        cancelled = true;
      };
    }
    setHistory(null);
    void api
      .conversation(workspaceId, activeChatSession)
      .then(({ messages, runs }) => {
        if (!cancelled) setHistory(initialMessages(workspaceId, messages, runs));
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(errorMessage(cause, "Could not load this conversation."));
        setHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, activeChatSession]);

  const refreshApprovals = useCallback(async () => {
    const { approvals } = await api.approvals(workspaceId);
    setPending(approvals.filter((approval) => !agentId || approval.agentId === agentId));
  }, [workspaceId, agentId]);

  useEffect(() => {
    void refreshApprovals();
    const interval = setInterval(() => void refreshApprovals(), 5_000);
    return () => clearInterval(interval);
  }, [refreshApprovals]);

  const selectedModel = models?.find((model) => modelKey(model) === selectedModelKey);
  const currentAgent = agents?.find((agent) => agent.id === agentId);
  const modelsByProvider = useMemo(() => {
    const grouped = new Map<string, ProviderModel[]>();
    for (const model of models ?? []) {
      grouped.set(model.provider, [...(grouped.get(model.provider) ?? []), model]);
    }
    return grouped;
  }, [models]);

  const chooseModel = useCallback((model: ProviderModel) => {
    setSelectedModelKey(modelKey(model));
    setReasoning(
      model.reasoningEfforts.includes("medium") ? "medium" : (model.reasoningEfforts[0] ?? ""),
    );
    setFastMode(false);
    setModelMenuOpen(false);
  }, []);

  const ComposerControls = useCallback(() => {
    return (
      <>
        <Popover open={modelMenuOpen} onOpenChange={setModelMenuOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="max-w-48 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
              aria-label="Select model"
            >
              {selectedModel ? (
                <ProviderLogo provider={selectedModel.provider} className="size-4 rounded-sm" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
              <span className="truncate">{selectedModel?.displayName ?? "Select model"}</span>
              <ChevronsUpDown className="size-3 opacity-60" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" side="top" className="w-[min(24rem,calc(100vw-2rem))] p-0">
            <Command>
              <CommandInput placeholder="Search connected models..." />
              <CommandList>
                <CommandEmpty>No connected model matches.</CommandEmpty>
                {[...modelsByProvider.entries()].map(([provider, providerModels]) => (
                  <CommandGroup
                    key={provider}
                    heading={providerModels[0]?.providerName ?? provider}
                  >
                    {providerModels.map((model) => (
                      <CommandItem
                        key={modelKey(model)}
                        value={`${model.providerName} ${model.displayName} ${model.id}`}
                        data-checked={modelKey(model) === selectedModelKey}
                        onSelect={() => chooseModel(model)}
                        className="py-2"
                      >
                        <ProviderLogo provider={model.provider} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{model.displayName}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {model.id}
                          </span>
                        </span>
                        {model.serviceTiers.includes("fast") && (
                          <span className="mr-5 inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                            <Zap className="size-3" /> Fast
                          </span>
                        )}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        {selectedModel?.reasoningEfforts.length ? (
          <Select
            value={reasoning}
            onValueChange={(value) => setReasoning(value as ReasoningEffort)}
          >
            <SelectTrigger
              size="sm"
              className="h-7 max-w-32 border-0 bg-transparent px-2 text-muted-foreground shadow-none hover:bg-muted hover:text-foreground"
              aria-label="Reasoning effort"
            >
              <BrainCircuit className="size-3.5" />
              <SelectValue placeholder="Reasoning" />
            </SelectTrigger>
            <SelectContent position="popper" side="top" align="start">
              <SelectGroup>
                <SelectLabel>Reasoning effort</SelectLabel>
                {selectedModel.reasoningEfforts.map((effort) => (
                  <SelectItem key={effort} value={effort}>
                    {EFFORT_LABELS[effort]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        ) : null}

        {selectedModel?.serviceTiers.includes("fast") ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
                <Zap className="size-3.5" />
                <span>Fast</span>
                <Switch
                  size="sm"
                  checked={fastMode}
                  onCheckedChange={setFastMode}
                  aria-label="Fast mode"
                />
              </div>
            </TooltipTrigger>
            <TooltipContent side="top">Prioritize lower latency for this model</TooltipContent>
          </Tooltip>
        ) : null}
      </>
    );
  }, [
    chooseModel,
    fastMode,
    modelMenuOpen,
    modelsByProvider,
    reasoning,
    selectedModel,
    selectedModelKey,
  ]);

  const Welcome = useCallback(
    () => (
      <div className="mb-7 flex flex-col items-center px-4 text-center">
        <AgentArtwork className="mb-4 size-14" />
        <h1 className="text-xl font-semibold tracking-normal sm:text-2xl">
          Start a conversation with {currentAgent?.name ?? "your agent"}
        </h1>
        <p className="mt-2 max-w-lg text-sm text-muted-foreground">
          Add files, choose any connected model, and tune its reasoning before you send.
        </p>
      </div>
    ),
    [currentAgent?.name],
  );

  const onConversationCreated = useCallback(
    (nextConversationId: string) => {
      setParams({ agent: agentId, conversation: nextConversationId }, { replace: true });
    },
    [agentId, setParams],
  );

  const decide = async (approval: Approval, approved: boolean) => {
    setDecidingApproval(approval.id);
    setError(null);
    try {
      if (approved) await api.approve(workspaceId, approval.id);
      else await api.deny(workspaceId, approval.id);
      await api.streamRun(workspaceId, approval.runId, {
        onDelta: () => undefined,
        onStep: () => undefined,
        onStatus: () => undefined,
      });
      await refreshApprovals();
      if (conversationId) {
        const { messages, runs } = await api.conversation(workspaceId, conversationId);
        setHistory(initialMessages(workspaceId, messages, runs));
      }
      setHistoryRevision((revision) => revision + 1);
    } catch (cause) {
      setError(errorMessage(cause, "Could not submit that approval decision."));
    } finally {
      setDecidingApproval(null);
    }
  };

  if (!agents || !models || history === null) return <ChatLoading />;
  const deployed = agents.filter((agent) => agent.status === "deployed");

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b bg-background/95 px-3 py-2 backdrop-blur sm:px-5">
        <Select
          value={agentId}
          onValueChange={(value) => {
            setParams({ agent: value }, { replace: true });
            setHistory([]);
          }}
        >
          <SelectTrigger className="min-w-0 flex-1 sm:w-56 sm:flex-none" aria-label="Chat agent">
            <AgentArtwork className="size-5" />
            <SelectValue placeholder="Select a deployed agent" />
          </SelectTrigger>
          <SelectContent align="start">
            <SelectGroup>
              <SelectLabel>Deployed agents</SelectLabel>
              {deployed.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  <span className="size-1.5 rounded-full bg-emerald-500" />
                  {agent.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>

        <div className="hidden items-center gap-1.5 text-xs text-muted-foreground md:flex">
          {selectedModel ? (
            <>
              <ProviderLogo provider={selectedModel.provider} className="size-4 rounded-sm" />
              <span>{selectedModel.providerName}</span>
              <span className="text-border">/</span>
              <span>{selectedModel.displayName}</span>
            </>
          ) : (
            <span>No connected models</span>
          )}
        </div>

        <Button
          variant="outline"
          className="ml-auto"
          onClick={() => {
            setHistory([]);
            setParams(newChatParams(agentId), { replace: true });
          }}
        >
          <CirclePlus />
          <span className="hidden sm:inline">New chat</span>
        </Button>
      </div>

      {(error ||
        modelError ||
        pending.length > 0 ||
        deployed.length === 0 ||
        models.length === 0) && (
        <div className="grid shrink-0 gap-2 border-b bg-muted/20 px-3 py-3 sm:px-5 lg:grid-cols-2">
          {error && (
            <Alert variant="destructive" className="bg-background">
              <AlertCircle />
              <AlertTitle>Chat error</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {modelError && (
            <Alert className="bg-background">
              <Gauge />
              <AlertTitle>Model list unavailable</AlertTitle>
              <AlertDescription>
                Chat can still use the agent's configured model. Manage providers in Settings.
              </AlertDescription>
            </Alert>
          )}
          {deployed.length === 0 && (
            <Alert className="bg-background">
              <AgentArtwork className="size-4" />
              <AlertTitle>No deployed agents</AlertTitle>
              <AlertDescription>Deploy an agent before starting a conversation.</AlertDescription>
            </Alert>
          )}
          {models.length === 0 && !modelError && (
            <Alert className="bg-background">
              <Gauge />
              <AlertTitle>No connected models</AlertTitle>
              <AlertDescription>Connect a model provider from Settings.</AlertDescription>
            </Alert>
          )}
          {pending.map((approval) => (
            <Alert
              key={approval.id}
              className="border-amber-300 bg-amber-50/70 dark:border-amber-900 dark:bg-amber-950/20"
            >
              <AlertTitle className="flex items-center gap-2">
                <ToolIcon tool={approval.toolName} className="size-5" />
                {approval.toolName} needs approval
              </AlertTitle>
              <AlertDescription>
                {approval.agentName ?? "This agent"} wants to {approval.action}.
                {approvalTarget(approval) && (
                  <code className="mt-1 block truncate font-mono text-xs opacity-80">
                    {approvalTarget(approval)}
                  </code>
                )}
              </AlertDescription>
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  onClick={() => void decide(approval, true)}
                  disabled={decidingApproval === approval.id}
                >
                  {decidingApproval === approval.id ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Check />
                  )}
                  Allow
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void decide(approval, false)}
                  disabled={decidingApproval === approval.id}
                >
                  Deny
                </Button>
              </div>
            </Alert>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1">
        {agentId ? (
          <BridgeAssistantRuntime
            key={`${agentId}:${activeChatSession}:${historyRevision}`}
            workspaceId={workspaceId}
            agentId={agentId}
            conversationId={conversationId}
            messages={history}
            selectedModel={selectedModel}
            reasoning={reasoning || undefined}
            fastMode={fastMode}
            onConversationCreated={onConversationCreated}
            onWaitingApproval={refreshApprovals}
            ComposerControls={ComposerControls}
            Welcome={Welcome}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center p-6 text-center">
            <AgentArtwork className="mb-4 size-12" />
            <h2 className="font-semibold">No agent is ready for chat</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Create and deploy an agent to open the assistant workspace.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
