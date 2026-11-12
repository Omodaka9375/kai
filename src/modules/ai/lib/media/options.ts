/** Normalize the common WIDTHxHEIGHT tool option to each image API's ratio
 * enum. The provider chooses its own pixel dimensions and quality. */
export function aspectRatioForSize(
  size: string | undefined,
  ratios: readonly string[],
  maxRelativeDelta = 0.15,
): string | undefined {
  if (!size) return undefined;
  const match = /^(\d{1,5})x(\d{1,5})$/.exec(size);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return undefined;
  const ratio = width / height;
  let best: string | undefined;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const label of ratios) {
    const parts = label.split(":").map(Number);
    if (parts.length !== 2 || !parts[0] || !parts[1]) continue;
    const delta = Math.abs(parts[0]! / parts[1]! - ratio);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = label;
    }
  }
  return bestDelta / ratio < maxRelativeDelta ? best : undefined;
}
