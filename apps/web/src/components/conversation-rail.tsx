'use client';

import { useCallback, useEffect, useState } from 'react';
import { cn } from '../lib/utils';

export type ConversationAnchor = {
  id: string;
  label: string;
  toolCount?: number;
};

const MIN_TURNS = 3;
/** Collapsed minimap tick — fixed size for every turn */
const MARKER_WIDTH_PX = 12;
const MARKER_HEIGHT_PX = 2;
/** Shared vertical rhythm between ticks and expanded rows */
const TURN_GAP_CLASS = 'gap-2';
const TURN_ROW_MIN_H = 'min-h-7';

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
  scrollContainerRef,
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

  // Scroll-spy: highlight the turn most visible in the scroll viewport.
  // Observes each turn section and picks the entry with the highest
  // intersection ratio as the active anchor.
  useEffect(() => {
    const root = scrollContainerRef.current;
    if (!root || anchors.length < MIN_TURNS) return;
    const ratios = new Map<string, number>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.id.replace(/^conversation-anchor-/, '');
          ratios.set(id, entry.isIntersecting ? entry.intersectionRatio : 0);
        }
        let bestId: string | null = null;
        let bestRatio = 0;
        for (const anchor of anchors) {
          const ratio = ratios.get(anchor.id) ?? 0;
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestId = anchor.id;
          }
        }
        if (bestId) setActiveId(bestId);
      },
      { root, threshold: [0, 0.25, 0.5, 0.75, 1] },
    );

    for (const anchor of anchors) {
      const el = getAnchorElement(anchor.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [anchors, scrollContainerRef, getAnchorElement]);

  if (anchors.length < MIN_TURNS) return null;

  return (
    <div
      className="pointer-events-none absolute inset-y-0 left-5 z-20 hidden w-20 sm:block cursor-pointer"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        className={cn(
          'pointer-events-auto absolute top-1/2 left-0 -translate-y-1/2 transition-[width,opacity] duration-200 ease-out',
          hovered
            ? 'w-52 transition-all duration-400 ease-initial'
            : 'w-3 transition-all duration-300 ease-out',
        )}
        role="navigation"
        aria-label="Conversation turns"
      >
        <div
          className={cn(
            'relative rounded-md border border-transparent transition-colors',
            hovered &&
              'border-border/50 px-2 py-2 bg-card',
          )}
        >
          {hovered ? (
            <ul className={cn('flex flex-col', TURN_GAP_CLASS)}>
              {anchors.map((anchor) => (
                <li key={anchor.id}>
                  <button
                    type="button"
                    onClick={() => {
                      scrollToAnchor(anchor.id);
                      setHovered(false);
                    }}
                    className={cn(
                      'flex w-full items-center rounded-sm px-2 py-1.5 text-left text-xs leading-snug transition-colors',
                      TURN_ROW_MIN_H,
                      activeId === anchor.id
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground hover:bg-sidebar/60 hover:text-foreground cursor-pointer',
                    )}
                    title={anchor.label.slice(0, 100) + '...'}
                  >
                    <span className="line-clamp-1">
                      {truncateLabel(anchor.label)}
                      {anchor.toolCount && anchor.toolCount > 0 ? (
                        <span className="text-muted-foreground/70">
                          {' · '}
                          {anchor.toolCount}{' '}
                          {anchor.toolCount === 1 ? 'tool' : 'tools'}
                        </span>
                      ) : null}
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
                  className="flex w-full min-h-3 items-center justify-end"
                >
                  <button
                    type="button"
                    onClick={() => scrollToAnchor(anchor.id)}
                    className={cn(
                      'shrink-0 rounded-[1px] transition-colors hover:bg-foreground/70',
                      activeId === anchor.id
                        ? 'bg-foreground/80'
                        : 'bg-muted-foreground/40',
                    )}
                    style={{
                      width: MARKER_WIDTH_PX,
                      height: MARKER_HEIGHT_PX,
                    }}
                    aria-label={truncateLabel(anchor.label)}
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
