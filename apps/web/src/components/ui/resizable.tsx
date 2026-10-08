'use client';

import * as React from 'react';
import * as ResizablePrimitive from 'react-resizable-panels';
import { cn } from '@/lib/utils';

function ResizablePanelGroup({
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelGroup>) {
  return (
    <ResizablePrimitive.PanelGroup
      data-slot="resizable-panel-group"
      className={cn(
        'flex h-full w-full data-[panel-group-direction=vertical]:flex-col',
        className,
      )}
      {...props}
    />
  );
}

function ResizablePanel({
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.Panel>) {
  return (
    <ResizablePrimitive.Panel
      data-slot="resizable-panel"
      className={cn('min-h-0 min-w-0', className)}
      {...props}
    />
  );
}

/**
 * IDE-style edge resize: no grip, ~16px invisible hit strip on the seam,
 * 1px hairline brightens on hover and while dragging.
 */
function ResizableHandle({
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelResizeHandle>) {
  return (
    <ResizablePrimitive.PanelResizeHandle
      data-slot="resizable-handle"
      aria-label="Resize sidebar"
      className={cn(
        'relative z-20 w-0 shrink-0 cursor-col-resize touch-none select-none focus-visible:outline-none',
        'before:absolute before:inset-y-0 before:left-0 before:w-px before:bg-border/30 before:transition-[background-color] before:duration-150 before:content-[""]',
        'hover:before:bg-border/80 data-[resize-handle-active]:before:bg-primary/50',
        'after:absolute after:inset-y-0 after:-left-2 after:w-4 after:content-[""]',
        'focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-0',
        className,
      )}
      {...props}
    />
  );
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
