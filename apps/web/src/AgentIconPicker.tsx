import { Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { AgentArtwork } from "./AgentArtwork.jsx";
import { Button } from "./components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover.js";

/**
 * Choosing what an agent looks like.
 *
 * Emoji first, because picking one is a single click and needs no file on
 * disk, no image editor, and no explanation. Uploading a picture is there for
 * people who want their own, and is downscaled before it ever leaves the
 * browser — the icon travels inside the manifest, and a manifest is not a
 * place to keep a four-megabyte photograph.
 */
const EMOJI = [
  "🤖",
  "🤝",
  "📬",
  "🗒️",
  "✍️",
  "🎧",
  "📈",
  "📣",
  "🧑‍💼",
  "⚙️",
  "🔍",
  "🛰️",
  "🔬",
  "📊",
  "📚",
  "🏃",
  "✈️",
  "🏠",
  "💷",
  "🧠",
  "☀️",
  "🌙",
  "🔔",
  "📌",
  "🗂️",
  "🧭",
  "🛠️",
  "🧾",
  "💡",
  "🎯",
  "🚀",
  "🧩",
  "🌱",
  "🐙",
  "🦉",
  "🐝",
  "🎨",
  "🎬",
  "🍳",
  "⚡",
];

const COLORS = [
  "#4C6EF5",
  "#2FA37A",
  "#E2557B",
  "#B45FD8",
  "#E0A32E",
  "#1E9AB0",
  "#D2603A",
  "#5B6470",
  "#3AAE5F",
  "#9B59B6",
];

/** Longest side 128px, PNG. Big enough to look sharp, small enough to embed. */
const MAX_EDGE = 128;

async function downscale(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not read that image.");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/png");
}

export function AgentIconPicker({
  icon,
  color,
  name,
  onChange,
}: {
  icon?: string;
  color?: string;
  name?: string;
  onChange: (next: { icon?: string; color?: string }) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      onChange({ icon: await downscale(file), color });
    } catch {
      setError("That file could not be read as an image.");
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="size-16 shrink-0 p-0"
          aria-label={name ? `Change ${name}'s icon` : "Change icon"}
        >
          <AgentArtwork icon={icon} color={color} className="size-11" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <div className="grid grid-cols-8 gap-1">
          {EMOJI.map((choice) => (
            <button
              key={choice}
              type="button"
              onClick={() => onChange({ icon: choice, color })}
              aria-label={choice}
              aria-pressed={icon === choice}
              className={`flex size-8 items-center justify-center rounded-md text-lg transition hover:bg-muted ${
                icon === choice ? "bg-muted ring-2 ring-ring" : ""
              }`}
            >
              {choice}
            </button>
          ))}
        </div>

        <p className="mt-3 mb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
          Background
        </p>
        <div className="flex flex-wrap gap-1.5">
          {COLORS.map((choice) => (
            <button
              key={choice}
              type="button"
              onClick={() => onChange({ icon, color: choice })}
              aria-label={`Background ${choice}`}
              aria-pressed={color === choice}
              className={`size-6 rounded-full border transition ${
                color === choice ? "ring-2 ring-ring ring-offset-2 ring-offset-background" : ""
              }`}
              style={{ backgroundColor: choice }}
            />
          ))}
        </div>

        <div className="mt-4 flex gap-2 border-t pt-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => fileInput.current?.click()}
          >
            <Upload /> Upload
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!icon}
            onClick={() => onChange({ icon: undefined, color: undefined })}
          >
            <Trash2 /> Reset
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => void upload(event.target.files?.[0])}
          />
        </div>
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      </PopoverContent>
    </Popover>
  );
}
