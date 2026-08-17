import type { CommandResult } from "@bridge/commands";
import { TerminalIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "../components/ui/button.js";
import { SlashCommands } from "./SlashCommands.jsx";
import { type CommandOutcome, useCommands } from "./useCommands.js";

/**
 * Bridge commands inside the chat page.
 *
 * Results appear above the composer rather than in the conversation: a
 * command is something you asked *Bridge*, not something you said to an
 * agent, and putting "here are your 4 automations" into the thread would
 * feed it back to the model as context on the next message.
 *
 * Positioned against the composer's own rectangle rather than by nesting
 * inside it — the composer belongs to assistant-ui, and reaching into its
 * layout to add a panel is how you end up maintaining a fork of it.
 */
interface Anchor {
  left: number;
  width: number;
  bottom: number;
}

export function CommandLayer() {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [outcome, setOutcome] = useState<CommandOutcome | null>(null);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const { run, running } = useCommands();

  useEffect(() => {
    let frame = 0;
    let tries = 0;
    const observer = new ResizeObserver(() => measure());
    let input: HTMLTextAreaElement | null = null;

    const measure = () => {
      const shell = input?.closest("[data-slot='aui_composer-shell']") ?? input;
      if (!shell) return;
      const rect = shell.getBoundingClientRect();
      setAnchor({
        left: rect.left,
        width: rect.width,
        bottom: window.innerHeight - rect.top + 8,
      });
    };

    const attach = () => {
      input = document.querySelector<HTMLTextAreaElement>("textarea.aui-composer-input");
      if (!input) {
        // The thread mounts asynchronously; look again for a short while.
        if (tries++ < 60) frame = window.setTimeout(attach, 50);
        return;
      }
      ref.current = input;

      /**
       * Measured when it matters, not once at mount. The composer's position
       * is not settled while the page is still laying out, and an anchor
       * captured then leaves the panel floating somewhere near the middle of
       * the screen. Typing is exactly when this becomes visible, so that is
       * when it is measured.
       */
      input.addEventListener("input", measure);
      input.addEventListener("focus", measure);
      const shell = input.closest("[data-slot='aui_composer-shell']");
      if (shell) observer.observe(shell);
      measure();
    };

    attach();
    window.addEventListener("resize", measure);

    return () => {
      window.clearTimeout(frame);
      window.removeEventListener("resize", measure);
      input?.removeEventListener("input", measure);
      input?.removeEventListener("focus", measure);
      observer.disconnect();
    };
  }, []);

  if (!anchor) return null;

  /**
   * Rendered into the body, because a `fixed` element is positioned against
   * the nearest transformed ancestor rather than the viewport — and the chat
   * layout has one. Without the portal the panel lands hundreds of pixels
   * from the composer it is supposed to sit above.
   */
  return createPortal(
    <div
      className="pointer-events-none fixed z-40 flex flex-col gap-2"
      style={{ left: anchor.left, width: anchor.width, bottom: anchor.bottom }}
    >
      {outcome && (
        <div className="pointer-events-auto">
          <CommandOutput outcome={outcome} onClose={() => setOutcome(null)} />
        </div>
      )}
      {running && (
        <p className="pointer-events-auto px-1 text-xs text-muted-foreground">Running command…</p>
      )}
      <div className="pointer-events-auto">
        <SlashCommands inputRef={ref} onRun={(value) => void run(value).then(setOutcome)} />
      </div>
    </div>,
    document.body,
  );
}

function CommandOutput({ outcome, onClose }: { outcome: CommandOutcome; onClose: () => void }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <TerminalIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
        <span className="font-mono text-xs text-muted-foreground">/{outcome.input}</span>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={onClose}
          aria-label="Dismiss command output"
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>
      <div className="max-h-64 overflow-auto p-3">
        {outcome.error ? (
          <p className="text-sm text-destructive">{outcome.error}</p>
        ) : (
          <ResultBody result={outcome.result} />
        )}
      </div>
    </div>
  );
}

/** The counterpart of the CLI's renderer: same result, drawn for a page. */
function ResultBody({ result }: { result?: CommandResult }) {
  if (!result) return null;

  // Keyed by content: command output is a snapshot, never reordered in place.
  const columns = result.table?.columns ?? [];
  const rows = (result.table?.rows ?? []).map((row) => ({
    key: row.join("\u0000"),
    cells: row.map((cell, index) => ({
      column: columns[index] ?? String(index),
      value: cell === null ? "—" : String(cell),
    })),
  }));
  return (
    <div className="flex flex-col gap-3">
      {result.text && <p className="whitespace-pre-wrap text-sm">{result.text}</p>}
      {result.table && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-muted-foreground">
                {columns.map((column) => (
                  <th key={column} className="pb-1 pr-4 font-medium uppercase tracking-wide">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-t border-border/40">
                  {row.cells.map((cell) => (
                    <td key={cell.column} className="py-1 pr-4 align-top font-mono">
                      {cell.value}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
