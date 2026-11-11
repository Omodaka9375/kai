/// <reference types="vite/client" />

// Per-icon deep imports ("@hugeicons/core-free-icons/RocketIcon") have no
// per-file .d.ts in the package, so the subpath gets a minimal ambient type.
// Only projectIcons.ts may use this - it keeps the icon pack out of the
// main bundle while the full index stays behind a dynamic import.
declare module "@hugeicons/core-free-icons/*" {
  import type { IconSvgElement } from "@hugeicons/react";
  const icon: IconSvgElement;
  export default icon;
}
