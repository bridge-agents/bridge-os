import {
  type CommandDef,
  CommandError,
  type CommandResult,
  parseCommand,
  searchCommands,
} from "@bridge/commands";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BridgeApiError, request } from "../api.js";
import { useWorkspaceId } from "../session.jsx";

/**
 * Running a Bridge command from the web app.
 *
 * The command itself lives in `@bridge/commands` and is the same value the
 * CLI runs — this hook only supplies the workspace, an HTTP transport, and
 * somewhere for the result to go.
 */
export interface CommandOutcome {
  input: string;
  result?: CommandResult;
  error?: string;
}

export function useCommands() {
  const workspaceId = useWorkspaceId();
  const navigate = useNavigate();
  const [running, setRunning] = useState(false);

  const ctx = useMemo(
    () => ({
      workspaceId,
      request: <T>(path: string, init?: { method?: string; body?: unknown }) =>
        request<T>(path, {
          ...(init?.method ? { method: init.method } : {}),
          ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        }),
    }),
    [workspaceId],
  );

  const run = useCallback(
    async (input: string): Promise<CommandOutcome> => {
      setRunning(true);
      try {
        const { command, args } = parseCommand(input);
        const result = await command.run(ctx, args);
        // A command that says where to go gets to take you there — "run
        // helper …" should land in the conversation it just started.
        if (result.navigate) navigate(result.navigate);
        return { input, result };
      } catch (err) {
        return {
          input,
          error:
            err instanceof CommandError
              ? err.message
              : err instanceof BridgeApiError
                ? err.error.message
                : "That did not work.",
        };
      } finally {
        setRunning(false);
      }
    },
    [ctx, navigate],
  );

  return { run, running };
}

/** Commands matching what has been typed, for the palette. */
export function useCommandMatches(query: string): CommandDef[] {
  return useMemo(() => searchCommands(query, "web").slice(0, 8), [query]);
}
