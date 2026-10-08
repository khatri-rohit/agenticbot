'use client';

import { useRef, useState } from 'react';
import type { ImperativePanelHandle } from 'react-resizable-panels';
import { Sidebar } from './sidebar';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { cn } from '../lib/utils';

export function ChatShell({
  header,
  children,
  footer,
  layout = 'thread',
}: {
  header?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  layout?: 'thread' | 'home';
}) {
  const isHome = layout === 'home';
  const sidebarRef = useRef<ImperativePanelHandle>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  return (
    <div className="flex min-h-[100dvh] h-[100dvh] w-full bg-background">
      <ResizablePanelGroup
        direction="horizontal"
        autoSaveId="agenticbot-sidebar"
        className="min-h-0 min-w-0 flex-1"
      >
        <ResizablePanel
          ref={sidebarRef}
          id="sidebar"
          order={1}
          defaultSize={20}
          minSize={14}
          maxSize={36}
          collapsible
          collapsedSize={2.5}
          onCollapse={() => setSidebarCollapsed(true)}
          onExpand={() => setSidebarCollapsed(false)}
          className="flex min-h-0 flex-col bg-sidebar"
        >
          <Sidebar
            collapsed={sidebarCollapsed}
            onCollapse={() => sidebarRef.current?.collapse()}
            onExpand={() => sidebarRef.current?.expand()}
          />
        </ResizablePanel>
        <ResizableHandle withHandle className="cursor-col-resize" />
        <ResizablePanel id="main" order={2} minSize={40} defaultSize={80}>
          <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
            {header}
            <main
              className={cn(
                'flex min-h-0 flex-1 flex-col',
                isHome && 'items-center justify-center px-6',
              )}
            >
              {children}
            </main>
            {footer}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

export function HomeHeader() {
  return null;
}
