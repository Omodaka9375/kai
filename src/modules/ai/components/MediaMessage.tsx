import { memo, useCallback, useMemo, useState } from "react";
import { MediaLightbox } from "./MediaLightbox";
import { saveMediaViaDialog } from "../lib/media/save";
import Image02Icon from "@hugeicons/core-free-icons/Image02Icon";
import Download04Icon from "@hugeicons/core-free-icons/Download04Icon";
import { HugeiconsIcon } from "@hugeicons/react";

type ImageEntry = {
  base64?: string;
  url?: string;
  mimeType: string;
  width: number;
  height: number;
};

type ImageOutput = {
  type: "image";
  base64?: string;
  url?: string;
  mimeType: string;
  width: number;
  height: number;
  provider: string;
  prompt: string;
  /** Present when the user asked for more than one image. The single fields
   *  above mirror entry 0 so single-image consumers stay unchanged. */
  images?: ImageEntry[];
};

type VideoEntry = {
  url: string;
  base64?: string;
  mimeType: string;
  durationSeconds: number;
  thumbnailBase64?: string;
};

type VideoOutput = {
  type: "video";
  url: string;
  /** Inline bytes — Omni's URI needs an auth header, so bytes are the only
   * thing a bare <video src> can play. */
  base64?: string;
  mimeType: string;
  durationSeconds: number;
  provider: string;
  thumbnailBase64?: string;
  prompt: string;
  /** Present when the user asked for more than one video. The single fields
   *  above mirror entry 0. */
  videos?: VideoEntry[];
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

/** A media-generation job that is still running in the background. */
export type MediaGeneratingOutput = {
  status: "generating";
  kind: "image" | "video";
  provider: string;
  /** Human label for the engine that was ACTUALLY picked — set when the
   *  requested provider had no key and KAI substituted another one. */
  providerLabel?: string;
  prompt: string;
};

/** Detect if a tool output is an in-progress background generation. */
export function isGeneratingMedia(
  output: unknown,
): output is MediaGeneratingOutput {
  if (!output || typeof output !== "object") return false;
  const o = output as Record<string, unknown>;
  return (
    o.status === "generating" &&
    (o.kind === "image" || o.kind === "video") &&
    typeof o.provider === "string"
  );
}

/** Inline image or video in the chat conversation. */
function entrySrc(entry: { base64?: string; mimeType: string; url?: string }): string {
  return entry.base64
    ? `data:${entry.mimeType};base64,${entry.base64}`
    : entry.url ?? "";
}

export const MediaMessage = memo(function MediaMessage({ output }: Props) {
  const [lightbox, setLightbox] = useState(false);
  // Which image the lightbox opened (multi-image cards). -1 = closed.
  const [lightboxIndex, setLightboxIndex] = useState(-1);

  // Every image to render: the `images` array when the request asked for
  // several, else the single fields. An empty source is dropped so a broken
  // entry cannot render a blank frame.
  const imageEntries = useMemo<ImageEntry[]>(() => {
    if (output.type !== "image") return [];
    const all = output.images ?? [output];
    return all.filter((e) => entrySrc(e) !== "");
  }, [output]);

  // Video: prefer inline bytes — Omni's URI needs an auth header to fetch,
  // which a bare <video src> cannot send.
  const videoEntries = useMemo<VideoEntry[]>(() => {
    if (output.type !== "video") return [];
    return (output.videos ?? [output]).filter((e) => entrySrc(e) !== "");
  }, [output]);

  const src = useMemo(() => {
    if (output.type === "image") {
      return imageEntries.length > 0 ? entrySrc(imageEntries[0]!) : "";
    }
    return videoEntries.length > 0 ? entrySrc(videoEntries[0]!) : "";
  }, [output, imageEntries, videoEntries]);

  if (!src) return null;
  const multi = output.type === "image"
    ? imageEntries.length > 1
    : videoEntries.length > 1;
  const count = output.type === "image" ? imageEntries.length : videoEntries.length;

  // The provider id is engine-level ("google"), but images and videos use
  // DIFFERENT Google engines — Nano Banana 2.1 vs Gemini Omni Flash. Label by
  // media kind so a video card stops claiming it came from the image model.
  const providerLabel = {
    openai: "GPT Image 2.6 Flare",
    google: output.type === "video" ? "Gemini Omni Flash" : "Nano Banana 2.1",
    xai: output.type === "video" ? "Grok Imagine Video 1.5 Lite" : "Grok Imagine Image 2.0",
    veo: "Gemini Omni Flash",
  }[output.provider] ?? output.provider;

  // Native save dialog -> fs_write_file_bytes. The old <a download> click
  // was a silent no-op under the Tauri webview (no download manager), so
  // the Save button did nothing. Cancellation is not an error.
  const download = useCallback(
    async (entry?: ImageEntry) => {
      try {
        await saveMediaViaDialog({
          src: entry ? entrySrc(entry) : src,
          prompt: output.prompt,
          kind: output.type,
        });
      } catch (err) {
        console.error("[kai] media save failed:", err);
      }
    },
    [src, output.prompt, output.type],
  );

  return (
    <>
      <div className="group/media flex flex-col gap-1.5 rounded-lg border border-border/40 bg-card/60 p-2">
        <div className="relative overflow-hidden rounded-md">
          {output.type === "image" ? (
            multi ? (
              // One request that asked for several images renders them as a
              // grid inside ONE card, so the user sees a single result set
              // rather than N cards that look like N separate generations.
              <div className="grid grid-cols-2 gap-1.5">
                {imageEntries.map((entry, i) => (
                  <img
                    key={`${i}-${entry.mimeType}`}
                    src={entrySrc(entry)}
                    alt={`${output.prompt} (${i + 1})`}
                    className="max-h-52 w-full cursor-pointer rounded-md object-contain transition-transform hover:scale-[1.01]"
                    onClick={() => setLightboxIndex(i)}
                    draggable={false}
                  />
                ))}
              </div>
            ) : (
              <img
                src={src}
                alt={output.prompt}
                className="max-h-80 w-full cursor-pointer rounded-md object-contain transition-transform hover:scale-[1.01]"
                onClick={() => setLightbox(true)}
                draggable={false}
              />
            )
          ) : (
            <div className={multi ? "grid grid-cols-2 gap-1.5" : undefined}>
              {videoEntries.map((entry, i) => (
                <video
                  key={`${i}-${entry.mimeType}`}
                  src={entrySrc(entry)}
                  controls
                  className="max-h-80 w-full rounded-md"
                  poster={
                    entry.thumbnailBase64
                      ? `data:image/jpeg;base64,${entry.thumbnailBase64}`
                      : undefined
                  }
                />
              ))}
            </div>
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
              ? // display_image cards carry no known dimensions (0x0) -
                // omit the suffix rather than showing a bogus "0x0".
                output.width > 0 && output.height > 0
                ? ` · ${output.width}×${output.height}`
                : ""
              : output.durationSeconds > 0
                ? ` · ${output.durationSeconds}s`
                : ""}
            {multi ? ` · ${count} ${output.type === "image" ? "images" : "videos"}` : ""}
          </span>
          <button
            type="button"
            onClick={() => void download()}
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
      {output.type === "image" && multi
        ? lightboxIndex >= 0 && imageEntries[lightboxIndex] && (
            <MediaLightbox
              src={entrySrc(imageEntries[lightboxIndex]!)}
              alt={output.prompt}
              kind="image"
              onClose={() => setLightboxIndex(-1)}
            />
          )
        : lightbox && (
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
