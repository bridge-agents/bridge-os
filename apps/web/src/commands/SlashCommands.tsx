import type { CommandDef } from "@bridge/commands";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils.js";
import { useCommandMatches } from "./useCommands.js";

/**
 * The "/" menu in a chat box.
 *
 * It attaches to the composer's own textarea rather than replacing it: the
 * chat input already handles attachments, dictation and sending, and a
 * parallel input would be a second thing to keep in step. So this watches
 * what is being typed, and while a line starts with "/" it takes over the
 * keys that mean "choose" — arrows, Tab, Enter, Escape — and leaves every
 * other keystroke to the composer.
 *
 * Enter runs the command instead of sending a message, which is the whole
 * point: "/approve abc" is an instruction to Bridge, not something to say to
 * an agent.
 */
export interface SlashCommandsProps {
  /** The composer textarea to watch. */
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onRun: (input: string) => void;
}

export function SlashCommands({ inputRef, onRun }: SlashCommandsProps) {
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const matches = useCommandMatches(query ?? "");

  /**
   * The key handler is registered once and reads the current selection from
   * here. Re-registering a capture listener on every keystroke would race
   * with the keystroke that caused it.
   */
  const state = useRef({ matches, active });
  state.current = { matches, active };

  const open = query !== null && matches.length > 0;

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;

    /** Only a line that *starts* with "/" is a command. */
    const read = () => {
      const value = input.value;
      setQuery(value.startsWith("/") ? value.slice(1) : null);
      setActive(0);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const value = input.value;
      if (!value.startsWith("/")) return;

      const { matches: current, active: index } = state.current;
      const highlighted = current[index];

      if (event.key === "Escape") {
        setQuery(null);
        event.stopPropagation();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (!current.length) return;
        event.preventDefault();
        event.stopPropagation();
        setActive((position) => {
          const next = event.key === "ArrowDown" ? position + 1 : position - 1;
          return (next + current.length) % current.length;
        });
        return;
      }
      if (event.key === "Tab" && highlighted) {
        // Complete the name and let them keep typing arguments.
        event.preventDefault();
        event.stopPropagation();
        setInputValue(input, `/${highlighted.name} `);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        /**
         * Stop the composer sending it as a message. `stopPropagation` in
         * the capture phase is what makes this work without patching
         * assistant-ui: the event never reaches its handler.
         */
        event.preventDefault();
        event.stopPropagation();

        const typed = value.slice(1).trim();
        const needsArgs = (highlighted?.args ?? []).some((arg) => arg.required);
        const naming = highlighted && typed !== highlighted.name && !typed.includes(" ");

        /**
         * Enter on a half-typed name completes it — but only when the
         * command still needs something. A command that takes no arguments
         * should just run: making someone press Enter twice to see their
         * automations is a menu, not a command line.
         */
        if (naming && needsArgs) {
          setInputValue(input, `/${highlighted.name} `);
          return;
        }

        const command = naming && highlighted ? highlighted.name : typed;
        if (!command) return;
        setInputValue(input, "");
        setQuery(null);
        onRun(command);
      }
    };

    input.addEventListener("input", read);
    // Capture phase: ahead of the composer's own key handling.
    input.addEventListener("keydown", onKeyDown, true);
    read();

    return () => {
      input.removeEventListener("input", read);
      input.removeEventListener("keydown", onKeyDown, true);
    };
  }, [inputRef, onRun]);

  if (!open) return null;

  return (
    <div
      role="listbox"
      aria-label="Bridge commands"
      className="absolute bottom-full left-0 z-50 mb-2 w-full overflow-hidden rounded-lg border border-border bg-popover shadow-lg"
    >
      <div className="border-b border-border/60 px-3 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        Bridge commands
      </div>
      <div className="max-h-72 overflow-y-auto py-1">
        {matches.map((command, index) => (
          <CommandRow key={command.name} command={command} selected={index === active} />
        ))}
      </div>
    </div>
  );
}

function CommandRow({ command, selected }: { command: CommandDef; selected: boolean }) {
  return (
    <div
      data-slash-item={command.name}
      aria-selected={selected}
      role="option"
      // Focus stays in the composer — this is a listbox you drive with the
      // arrow keys while still typing, so the options are never tab stops.
      tabIndex={-1}
      className={cn(
        "flex items-baseline gap-3 px-3 py-1.5 text-sm",
        selected && "bg-accent text-accent-foreground",
      )}
    >
      <span className="font-mono text-[13px]">
        /{command.name}
        {(command.args ?? []).map((arg) => (
          <span key={arg.name} className="text-muted-foreground">
            {" "}
            {arg.required ? `<${arg.name}>` : `[${arg.name}]`}
          </span>
        ))}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {command.summary}
      </span>
    </div>
  );
}

/**
 * Write to the textarea the way a person would.
 *
 * React tracks the value on the DOM node, so assigning `.value` directly is
 * invisible to it — the composer would keep its old state and send stale
 * text. Setting through the native setter and dispatching `input` is how a
 * controlled component finds out.
 */
function setInputValue(input: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
}
