'use client';

import { useEffect, useRef, useState } from 'react';
import type { ImperativePanelHandle } from 'react-resizable-panels';
import { Sidebar } from './sidebar';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { cn } from '../lib/utils';
import { getComposerFocus } from './composer-focus';
import {
  RecentThreadsSwitcher,
  isTypeToFocusKey,
} from './recent-threads-switcher';

function TypeToFocusListener() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isTypeToFocusKey(e)) return;
      const composer = getComposerFocus();
      if (!composer || composer.isLocked()) return;
      e.preventDefault();
      composer.insertText(e.key);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return null;
}

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
        autoSaveId="agent-sidebar"
        className="min-h-0 min-w-0 flex-1"
      >
        <ResizablePanel
          ref={sidebarRef}
          id="sidebar"
          order={1}
          defaultSize={14}
          minSize={14}
          maxSize={30}
          collapsible
          collapsedSize={4}
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
        <ResizableHandle
          disabled={sidebarCollapsed}
          tabIndex={sidebarCollapsed ? -1 : 0}
          className={cn(sidebarCollapsed && 'pointer-events-none opacity-0')}
        />
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
      <RecentThreadsSwitcher />
      <TypeToFocusListener />
    </div>
  );
}

export function HomeHeader() {
  return null;
}
