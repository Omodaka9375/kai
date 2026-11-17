import * as ResizablePrimitive from "react-resizable-panels"

import { cn } from "@/lib/utils"

function ResizablePanelGroup({
  className,
  ...props
}: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      // CURSOR HIJACK OFF (2026-11-17 report: "when I hover over a text or a
      // placeholder I get a <-> drag icon and I have to click again"). The
      // library's hover handling injects a DOC-LEVEL stylesheet rule
      // `*, *:hover { cursor: col-resize !important }` while the pointer is
      // anywhere inside the group's resize hit regions — which, with
      // adjacent panels and input placeholders sitting inside them, paints
      // the <-> cursor over half the UI, making elements LOOK non-interactive
      // ("do I have to click again?"). disableCursor skips that rule
      // entirely; the handle itself carries its own resize cursors via the
      // class below, which is the standard affordance. Coarse-pointer
      // (touch) devices lose nothing — they have no hover cursor anyway.
      disableCursor
      className={cn(
        "flex h-full w-full aria-[orientation=vertical]:flex-col",
        className
      )}
      {...props}
    />
  )
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean
}) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      // The handle keeps its own resize cursors (see disableCursor in the
      // Group above — the library's doc-level cursor rule is off, so the
      // affordance lives here where it belongs: only on the separator).
      className={cn(
        "relative flex w-px cursor-col-resize items-center justify-center bg-border ring-offset-background after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 aria-[orientation=horizontal]:cursor-row-resize [&[aria-orientation=horizontal]>div]:rotate-90",
        className
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-6 w-1 shrink-0 rounded-lg bg-border" />
      )}
    </ResizablePrimitive.Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
