import type { Terminal } from "@xterm/xterm";

/**
 * iTerm2 inline images (OSC 1337) for KAI terminals — rendered natively via
 * xterm decorations (no addon dependency; core has no image protocol support).
 */

/** Parse `File=name=...;size=...;inline=1:<base64>` from an OSC 1337 payload. */
export function parseOsc1337(
  oscParams: string,
): { name: string; base64Data: string } | null {
  const match = oscParams.match(/^File=name=([^;]*);size=\d+;inline=1:(.+)$/);
  if (!match) return null;
  return { name: match[1], base64Data: match[2] };
}

/** Sniff the MIME type from magic bytes (defaults to PNG). */
export function sniffImageMime(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8)
    return "image/jpeg";
  if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
    return "image/gif";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45)
    return "image/webp";
  return "image/png";
}

/** Track live decorations per terminal so a re-register never doubles them. */
const decorationsByTerm = new WeakMap<Terminal, Set<{ dispose: () => void }>>();

/** Cap simultaneous images per terminal (memory guard). */
const MAX_IMAGES_PER_TERM = 12;

/** Cap a single decoded image (~16 MB of pixels ≈ a huge screenshot).
 *  base64 chars → bytes is 3/4, so 22M chars ≈ 16 MB decoded. */
const MAX_BASE64_BYTES = 22_000_000;

/**
 * Register the OSC 1337 handler on a terminal. Returns a dispose function.
 * On `File=...inline=1:<b64>`: writes a newline, drops a decoration anchored
 * at the cursor line containing the decoded image, sized to the terminal.
 */
export function registerOscImageHandler(term: Terminal): () => void {
  const disposers = decorationsByTerm.get(term) ?? new Set();
  decorationsByTerm.set(term, disposers);

  const handler = term.parser.registerOscHandler(1337, (data) => {
    const parsed = parseOsc1337(data);
    if (!parsed) return false; // not our payload — let xterm ignore it
    try {
      renderImageDecoration(term, parsed.name, parsed.base64Data, disposers);
    } catch (e) {
      console.warn("[kai] osc1337 render failed:", e);
    }
    return true;
  });
  return () => handler.dispose();
}

function renderImageDecoration(
  term: Terminal,
  name: string,
  base64Data: string,
  registry: Set<{ dispose: () => void }>,
): void {
  // PTY output is UNTRUSTED (an SSH session or `cat` of an attacker file can
  // emit arbitrary OSC payloads). Cap the decoded size BEFORE decoding —
  // `atob` on a multi-hundred-MB string OOMs the renderer; the count cap
  // below bounds decorations, not the size of one.
  if (base64Data.length > MAX_BASE64_BYTES) return;
  const bytes = base64ToBytes(base64Data);
  if (bytes.length === 0) return;
  const mime = sniffImageMime(bytes);
  const url = URL.createObjectURL(
    new Blob([bytes as BlobPart], { type: mime }),
  );

  const marker = term.registerMarker(0);
  if (!marker) return;

  // Evict oldest when over the cap.
  while (registry.size >= MAX_IMAGES_PER_TERM) {
    const oldest = registry.values().next().value;
    if (!oldest) break;
    oldest.dispose();
    registry.delete(oldest);
  }

  const decoration = term.registerDecoration({
    marker,
    width: 1,
    height: 1,
  });
  if (!decoration) {
    marker.dispose();
    return;
  }

  const record = {
    dispose: () => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* noop */
      }
      decoration.dispose();
      marker.dispose();
    },
  };
  registry.add(record);

  // The terminal itself can close (tab killed) before anything disposes the
  // record via the cap — detach it from the registry so the Set doesn't hold
  // dead records (and their blob URLs) for the lifetime of a live terminal.
  decoration.onDispose(() => {
    registry.delete(record);
  });

  // onRender can fire more than once (xterm re-renders decorations on
  // resize/scroll-back); guard the element so we never stack a second <img>.
  decoration.onRender((element) => {
    const img = document.createElement("img");
    img.src = url;
    img.alt = name || "inline image";
    img.style.display = "block";
    img.style.maxWidth = "100%";
    img.style.maxHeight = "60vh";
    img.style.borderRadius = "6px";
    img.style.margin = "4px 0";
    img.onload = () => {
      // Scale down to the terminal's inner width; never upscale.
      const maxW = Math.max(120, (term.element?.clientWidth ?? 640) - 16);
      const scale = img.naturalWidth > maxW ? maxW / img.naturalWidth : 1;
      img.style.width = `${Math.round(img.naturalWidth * scale)}px`;
    };
    element.replaceChildren(img);
  });
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
