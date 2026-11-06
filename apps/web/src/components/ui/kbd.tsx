import { cn } from '@/lib/utils';

/** Keyboard shortcut hint, styled for use inside tooltips. */
export function Kbd({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'inline-flex h-4 min-w-4 items-center justify-center rounded-sm bg-background/20 px-1 font-mono text-[10px] font-medium leading-none text-background/80',
        className,
      )}
    >
      {children}
    </kbd>
  );
}