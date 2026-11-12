import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import Download04Icon from "@hugeicons/core-free-icons/Download04Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { saveMediaViaDialog } from "../lib/media/save";

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

  // Native save dialog -> fs_write_file_bytes. The old <a download> click
  // was a silent no-op under the Tauri webview (no download manager), so
  // the Download button did nothing.
  const download = useCallback(async () => {
    try {
      // `alt` is the full prompt - passed only for the default filename.
      await saveMediaViaDialog({ src, prompt: alt, kind });
    } catch (err) {
      console.error("[kai] media save failed:", err);
    }
  }, [src, alt, kind]);

  // Portaled to document.body: the chat wraps every message part in a
  // framer-motion div (PartAppear) with willChange: transform, which makes
  // that wrapper a containing block AND a stacking context. Rendered inline,
  // the lightbox's `fixed inset-0` was clamped to that message part and its
  // z-[9998] could not rise above sibling parts - tool output painted on top
  // of the image and clicks landed on the text instead of the close button.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt ?? "Media preview"}
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
            onClick={() => void download()}
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
    </div>,
    document.body,
  );
}
