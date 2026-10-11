/**
 * Relative-time formatting for session lists ("just now", "5m ago",
 * "yesterday", "Oct 3", …) — compact like chat UIs, absolute after a week.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * Compact relative time. Order of specificity mirrors chat apps:
 *   < 1 min  → "just now"
 *   < 1 h    → "5m ago"
 *   < 24 h   → "3h ago"
 *   < 7 d    → "4d ago" (or "yesterday" for 1d)
 *   ≥ 7 d    → absolute "Oct 3" (+ year only if a different calendar year)
 * Invalid/falsy timestamps → "" (renderers skip the element entirely).
 */
export function relativeTime(
  ts: number | null | undefined,
  now: number = Date.now(),
): string {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "";
  const diff = now - ts;
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 2 * DAY) return "yesterday";
  if (diff < WEEK) return `${Math.floor(diff / DAY)}d ago`;
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const monthDay = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return sameYear ? monthDay : `${monthDay}, ${d.getFullYear()}`;
}

/** title= tooltip variant: full absolute local time, e.g. for hover. */
export function absoluteTime(
  ts: number | null | undefined,
): string {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "";
  return new Date(ts).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}