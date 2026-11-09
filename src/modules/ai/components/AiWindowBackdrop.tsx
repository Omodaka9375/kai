import { createPortal } from "react-dom";

/**
 * The exact rectangle an expanded AI surface (mini window / group panel)
 * occupies. Shared with both surfaces' expanded className branches so the
 * matte behind them can never drift from the rect they paint (an offset
 * matte would itself leak editor content at its edges).
 */
export const AI_EXPANDED_WINDOW_GEOMETRY =
  "top-[2.85rem] right-2 bottom-[calc(var(--kai-input-bar-h,0px)+42px)] left-[calc(var(--kai-workspace-left,0px)+8px)]";

/**
 * Opaque matte behind an EXPANDED AI surface.
 *
 * Both expanded surfaces are rounded-cornered cards with translucent borders
 * floating over the workspace; at the corner cutouts (and along the
 * anti-aliased edge of the translucent border) the editor/terminal behind
 * them leaked through ("background tabs leak in those cracks"). This matte
 * paints the app background over the exact expanded rectangle, square-cornered
 * and one layer BELOW the surface (z-30 vs the surface's z-40), so the cracks
 * resolve to flat background instead of editor content.
 *
 * Portaled to document.body because both surfaces clip children with
 * overflow-hidden + rounded corners - an in-tree child cannot paint into the
 * corner cutouts it needs to cover. The expanded geometry's CSS vars
 * (--kai-input-bar-h, --kai-workspace-left) are written on
 * document.documentElement, so body-level placement still resolves them.
 * Rendered only while expanded; it is flat color, so it pops in and out
 * without animation while the surface animates over it.
 */
export function AiWindowBackdrop({ active }: { active: boolean }) {
  if (!active) return null;
  return createPortal(
    <div
      aria-hidden
      data-ai-window-backdrop
      className={`pointer-events-none fixed z-30 bg-background ${AI_EXPANDED_WINDOW_GEOMETRY}`}
    />,
    document.body,
  );
}
