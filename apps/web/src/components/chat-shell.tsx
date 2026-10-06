'use client';

import { Sidebar } from './sidebar';
import { Separator } from './ui/separator';

export function ChatShell({
  header,
  children,
  footer,
}: {
  header: React.ReactNode;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <div className="flex h-screen w-full">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        {header}
        <main className="flex min-h-0 flex-1 flex-col">{children}</main>
        {footer}
      </div>
    </div>
  );
}

export function HomeHeader() {
  return (
    <header className="shrink-0">
      <div className="px-6 py-4">
        <h1 className="text-sm font-medium text-muted-foreground">New chat</h1>
      </div>
      <Separator />
    </header>
  );
}
