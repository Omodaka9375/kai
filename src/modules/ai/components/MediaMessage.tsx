import { memo, useMemo, useState } from "react";
import { MediaLightbox } from "./MediaLightbox";
import {
  Image02Icon,
  Download04Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

type ImageOutput = {
  type: "image";
  base64?: string;
  url?: string;
  mimeType: string;
  width: number;
  height: number;
  provider: string;
  prompt: string;
};

type VideoOutput = {
  type: "video";
  url: string;
  mimeType: string;
  durationSeconds: number;
  provider: string;
  thumbnailBase64?: string;
  prompt: string;
};

type Props = {
  output: ImageOutput | VideoOutput;
};

/** Detect if a tool output contains generated media. */
export function isMediaOutput(
  output: unknown,
): output is ImageOutput | VideoOutput {
  if (!output || typeof output !== "object") return false;
  const o = output as Record<string, unknown>;
  return o.type === "image" || o.type === "video";
}

/** Inline image or video in the chat conversation. */
export const MediaMessage = memo(function MediaMessage({ output }: Props) {
  const [lightbox, setLightbox] = useState(false);

  const src = useMemo(() => {
    if (output.type === "image") {
      if (output.base64) return `data:${output.mimeType};base64,${output.base64}`;
      return output.url ?? "";
    }
    return output.url;
  }, [output]);

  if (!src) return null;

  const providerLabel = {
    openai: "GPT Image 2",
    google: "Nano Banana 2",
    xai: "Grok Imagine",
    kling: "Kling 3.0",
    veo: "Veo 3.1",
    seedance: "Seedance 2.0",
  }[output.provider] ?? output.provider;

  const download = () => {
    const a = document.createElement("a");
    a.href = src;
    a.download =
      output.type === "image" ? "kai-generated.png" : "kai-generated.mp4";
    a.click();
  };

  return (
    <>
      <div className="group/media flex flex-col gap-1.5 rounded-lg border border-border/40 bg-card/60 p-2">
        <div className="relative overflow-hidden rounded-md">
          {output.type === "image" ? (
            <img
              src={src}
              alt={output.prompt}
              className="max-h-80 w-full cursor-pointer rounded-md object-contain transition-transform hover:scale-[1.01]"
              onClick={() => setLightbox(true)}
              draggable={false}
            />
          ) : (
            <video
              src={src}
              controls
              className="max-h-80 w-full rounded-md"
              poster={
                output.thumbnailBase64
                  ? `data:image/jpeg;base64,${output.thumbnailBase64}`
                  : undefined
              }
            />
          )}
        </div>
        <div className="flex items-center gap-2 px-1">
          <HugeiconsIcon
            icon={Image02Icon}
            size={12}
            strokeWidth={1.75}
            className="shrink-0 text-muted-foreground"
          />
          <span className="flex-1 truncate text-[10.5px] text-muted-foreground">
            {providerLabel}
            {output.type === "image"
              ? ` · ${output.width}×${output.height}`
              : ` · ${output.durationSeconds}s`}
          </span>
          <button
            type="button"
            onClick={download}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground opacity-0 transition-opacity hover:bg-muted/60 hover:text-foreground group-hover/media:opacity-100"
            title="Download"
          >
            <HugeiconsIcon icon={Download04Icon} size={10} strokeWidth={2} />
            Save
          </button>
          {output.type === "image" && (
            <button
              type="button"
              onClick={() => setLightbox(true)}
              className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground opacity-0 transition-opacity hover:bg-muted/60 hover:text-foreground group-hover/media:opacity-100"
            >
              Enlarge
            </button>
          )}
        </div>
      </div>
      {lightbox && (
        <MediaLightbox
          src={src}
          alt={output.prompt}
          kind={output.type}
          onClose={() => setLightbox(false)}
        />
      )}
    </>
  );
});
