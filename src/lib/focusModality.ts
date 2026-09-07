/**
 * Focus-modality guard — fixes WebView2's `:focus-visible`-on-click quirk.
 *
 * On Windows, the WebView2 control matches `:focus-visible` for *pointer*
 * interactions (clicks/drags), so every control with a `focus-visible:ring-*`
 * keeps a sticky focus outline after being clicked. In a normal browser
 * `:focus-visible` only matches keyboard navigation, and the ring disappears
 * on mouse click.
 *
 * We can't change WebView2's heuristic, so we track the real input modality
 * ourselves and expose it as `html.kai-keyboard`. CSS suppresses focus rings
 * for pointer input and only honors them for keyboard users.
 */
let keyboardModality = false;

function setKeyboardModality(on: boolean): void {
  if (keyboardModality === on) return;
  keyboardModality = on;
  document.documentElement.classList.toggle("kai-keyboard", on);
}

export function installFocusModalityGuard(): void {
  // Any pointer press means the user is mouse/touch-driven — hide focus rings.
  window.addEventListener(
    "pointerdown",
    () => setKeyboardModality(false),
    { capture: true },
  );
  // Keyboard *navigation* keys (Tab / arrows / Enter / Space) drive focus.
  // Plain typing should not re-enable rings, mirroring the :focus-visible
  // heuristic.
  window.addEventListener(
    "keydown",
    (e) => {
      if (
        e.key === "Tab" ||
        e.key.startsWith("Arrow") ||
        e.key === "Enter" ||
        e.key === " "
      ) {
        setKeyboardModality(true);
      }
    },
    { capture: true },
  );
}
