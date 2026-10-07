'use client';

import { Sidebar } from './sidebar';
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

  return (
    <div className="flex h-screen w-full bg-background">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
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
    </div>
  );
}

export function HomeHeader() {
  return null;
}
