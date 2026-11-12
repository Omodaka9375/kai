import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import Download04Icon from "@hugeicons/core-free-icons/Download04Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect } from "react";
import { safeMediaFilename } from "../lib/media/filename";

/** `data:image/png;base64,...` -> `image/png`. Undefined for blob/http URLs,
 *  where the caller's `kind` supplies the fallback extension. */
function mimeTypeFromDataUri(src: string): string | undefined {
  const m = /^data:([^;,]+)[;,]/.exec(src);
  return m?.[1];
}

type Props = {
  /** Base64 data URI or blob URL. */
  src: string;
  alt?: string;
  kind: "image" | "video";
  onClose: () => void;
};

/** Fullscreen overlay for images and videos. */
export function MediaLightbox({ src, alt, kind, onClose }: Props) {
  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onKeyDown]);

  const download = () => {
    const a = document.createElement("a");
    a.href = src;
    // `alt` is the full prompt - never a filename. It flooded the save
    // dialog's name field and broke extension parsing.
    a.download = safeMediaFilename(alt, {
      mimeType: mimeTypeFromDataUri(src),
      kind,
    });
    a.click();
  };

  return (
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative max-h-[90vh] max-w-[90vw]"
        onClick={(e) => e.stopPropagation()}
      >
        {kind === "image" ? (
          <img
            src={src}
            alt={alt ?? "Generated image"}
            className="max-h-[85vh] max-w-[85vw] rounded-lg object-contain"
            draggable={false}
          />
        ) : (
          <video
            src={src}
            controls
            autoPlay
            className="max-h-[85vh] max-w-[85vw] rounded-lg"
          />
        )}
        <div className="absolute top-3 right-3 flex gap-1.5">
          <button
            type="button"
            onClick={download}
            className="flex size-8 items-center justify-center rounded-full bg-black/60 text-white/80 transition-colors hover:bg-black/80 hover:text-white"
            title="Download"
          >
            <HugeiconsIcon icon={Download04Icon} size={16} strokeWidth={2} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex size-8 items-center justify-center rounded-full bg-black/60 text-white/80 transition-colors hover:bg-black/80 hover:text-white"
            title="Close"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={16} strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  );
}
