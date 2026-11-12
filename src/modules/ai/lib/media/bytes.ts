/** Byte helpers shared by native media providers and their callers. */

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

/** Stable, cheap content identity for media-job dedupe keys. This is not a
 * security hash: it only prevents two different reference images with the
 * same prompt from sharing a paid result. */
export function fingerprintBase64(base64: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < base64.length; i++) {
    hash ^= base64.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${base64.length}:${(hash >>> 0).toString(36)}`;
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

/** Read real dimensions from the returned image instead of inventing a
 * 1024x1024 result for every provider. Unknown means 0x0, which the UI and
 * model summaries already treat as "not reported". */
export function imageDimensionsFromBase64(
  base64: string | undefined,
): { width: number; height: number } {
  const unknown = { width: 0, height: 0 };
  if (!base64) return unknown;
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(base64);
  } catch {
    return unknown;
  }
  try {
    // PNG: IHDR width/height.
    if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
      return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
    }
    // GIF: logical screen descriptor, little endian.
    if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49) {
      return {
        width: bytes[6]! | (bytes[7]! << 8),
        height: bytes[8]! | (bytes[9]! << 8),
      };
    }
    if (
      bytes.length >= 30 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
      const chunk = String.fromCharCode(...bytes.subarray(12, 16));
      if (chunk === "VP8X") {
        return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
      }
      if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
        return {
          width: (bytes[26]! | (bytes[27]! << 8)) & 0x3fff,
          height: (bytes[28]! | (bytes[29]! << 8)) & 0x3fff,
        };
      }
      if (chunk === "VP8L" && bytes[20] === 0x2f) {
        return {
          width: 1 + (bytes[21]! | ((bytes[22]! & 0x3f) << 8)),
          height: 1 + (((bytes[22]! >> 6) & 0x03) | (bytes[23]! << 2) | ((bytes[24]! & 0x0f) << 10)),
        };
      }
    }
    // JPEG: walk segments to a start-of-frame marker.
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) break;
        while (bytes[offset] === 0xff) offset++;
        const marker = bytes[offset]!;
        offset++;
        if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        const length = u16be(bytes, offset);
        if (length < 2) break;
        if (
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf)
        ) {
          return { width: u16be(bytes, offset + 5), height: u16be(bytes, offset + 3) };
        }
        offset += length;
      }
    }
  } catch {
    return unknown;
  }
  return unknown;
}
