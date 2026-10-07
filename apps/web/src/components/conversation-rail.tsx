'use client';

import { useCallback, useState } from 'react';
import { cn } from '../lib/utils';

export type ConversationAnchor = {
  id: string;
  label: string;
};

const MIN_TURNS = 3;
/** Collapsed minimap tick — fixed size for every turn */
const MARKER_WIDTH_PX = 12;
const MARKER_HEIGHT_PX = 2;
/** Shared vertical rhythm between ticks and expanded rows */
const TURN_GAP_CLASS = 'gap-2';
const TURN_ROW_MIN_H = 'min-h-2';

export function shouldShowConversationRail(userTurnCount: number): boolean {
  return userTurnCount >= MIN_TURNS;
}

function truncateLabel(text: string, max = 56): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}

export function ConversationRail({
  anchors,
  getAnchorElement,
}: {
  anchors: ConversationAnchor[];
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  getAnchorElement: (id: string) => HTMLElement | null;
}) {
  const [hovered, setHovered] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  const scrollToAnchor = useCallback(
    (id: string) => {
      const el = getAnchorElement(id);
      if (!el) return;
      setActiveId(id);
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    [getAnchorElement],
  );

  if (anchors.length < MIN_TURNS) return null;

  return (
    <div
      className="pointer-events-none absolute inset-y-0 left-5 z-20 hidden w-18 sm:block"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        className={cn(
          'pointer-events-auto absolute top-1/2 left-0 -translate-y-1/2 transition-[width,opacity] duration-200 ease-out',
          hovered ? 'w-52 opacity-100' : 'w-3 opacity-90',
        )}
        role="navigation"
        aria-label="Conversation turns"
      >
        <div
          className={cn(
            'relative rounded-md border border-transparent transition-colors',
            hovered &&
              'border-border/60 bg-popover/95 px-2 py-2 shadow-md backdrop-blur-md',
          )}
        >
          {hovered ? (
            <ul className={cn('flex flex-col', TURN_GAP_CLASS)}>
              {anchors.map((anchor) => (
                <li key={anchor.id}>
                  <button
                    type="button"
                    onClick={() => scrollToAnchor(anchor.id)}
                    className={cn(
                      'flex w-full items-center rounded-sm px-2 py-1.5 text-left text-xs leading-snug transition-colors',
                      TURN_ROW_MIN_H,
                      activeId === anchor.id
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                    )}
                    title={anchor.label}
                  >
                    <span className="line-clamp-1">
                      {truncateLabel(anchor.label)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className={cn('flex flex-col py-2', TURN_GAP_CLASS)}>
              {anchors.map((anchor) => (
                <div
                  key={anchor.id}
                  className={cn(
                    'flex w-full items-center justify-end',
                    TURN_ROW_MIN_H,
                  )}
                >
                  <button
                    type="button"
                    onClick={() => scrollToAnchor(anchor.id)}
                    className="shrink-0 rounded-[1px] bg-muted-foreground/50 transition-colors hover:bg-foreground/85"
                    style={{
                      width: MARKER_WIDTH_PX,
                      height: MARKER_HEIGHT_PX,
                    }}
                    aria-label={truncateLabel(anchor.label, 120)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
