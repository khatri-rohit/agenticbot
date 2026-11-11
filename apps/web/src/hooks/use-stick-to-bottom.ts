'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/** Distance from the bottom past which the jump button shows. */
const JUMP_THRESHOLD_PX = 96;
/** A user scroll that ends this close to the bottom re-engages follow. */
const RESTICK_THRESHOLD_PX = 24;
/** How long after a gesture a `scroll` event still counts as the user's. */
const USER_INTENT_MS = 300;

const SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
]);

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

/**
 * Follow new content only while the user is at the bottom.
 *
 * Stick/unstick is decided by user gestures (wheel, touch, scrollbar drag,
 * scroll keys), never by a bare `scroll` event: layout shifts (images loading,
 * the composer shrinking on send, a clamped scrollTop) also fire `scroll`, and
 * reading those as "user scrolled away" stranded the view mid-page.
 */
export function useStickToBottom(
  scrollRef: React.RefObject<HTMLElement | null>,
) {
  const [stickToBottom, setStickToBottom] = useState(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const stickRef = useRef(true);
  const rafRef = useRef(0);
  const userIntentUntil = useRef(0);
  const draggingScrollbar = useRef(false);

  const setStick = useCallback((stick: boolean) => {
    stickRef.current = stick;
    setStickToBottom(stick);
    if (stick) setShowJumpToBottom(false);
  }, []);

  const pinToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [scrollRef]);

  const scheduleFollow = useCallback(() => {
    if (!stickRef.current) return;
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      pinToBottom();
    });
  }, [pinToBottom]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const markUserIntent = () => {
      userIntentUntil.current = performance.now() + USER_INTENT_MS;
    };
    const userIsScrolling = () =>
      draggingScrollbar.current || performance.now() < userIntentUntil.current;

    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distance <= RESTICK_THRESHOLD_PX) {
        // Reaching the bottom by any means re-engages follow: touch momentum
        // can land there after the gesture window closed, and being at the
        // bottom is always a safe place to follow from.
        if (!stickRef.current) setStick(true);
      } else if (stickRef.current && userIsScrolling()) {
        // Only a user gesture detaches; layout-driven scrolls (image loads,
        // composer shrink) leave stick alone and the follow re-pins.
        setStick(false);
      }
      setShowJumpToBottom(!stickRef.current && distance > JUMP_THRESHOLD_PX);
    };

    const onWheel = (e: WheelEvent) => {
      markUserIntent();
      // Any upward intent detaches at once, so a follow scheduled in the same
      // frame cannot yank the view back down.
      if (e.deltaY < 0 && el.scrollHeight > el.clientHeight) setStick(false);
    };

    const onPointerDown = (e: PointerEvent) => {
      // Content clicks target children; only the scrollbar targets `el`.
      if (e.target === el) draggingScrollbar.current = true;
    };
    const onPointerUp = () => {
      if (!draggingScrollbar.current) return;
      draggingScrollbar.current = false;
      markUserIntent();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!SCROLL_KEYS.has(e.key) || isEditableTarget(e.target)) return;
      markUserIntent();
      if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home') {
        setStick(false);
      }
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', markUserIntent, { passive: true });
    el.addEventListener('touchmove', markUserIntent, { passive: true });
    el.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('keydown', onKeyDown);

    const ro = new ResizeObserver(() => scheduleFollow());
    ro.observe(el);
    const content = el.firstElementChild;
    if (content) ro.observe(content);

    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', markUserIntent);
      el.removeEventListener('touchmove', markUserIntent);
      el.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('keydown', onKeyDown);
      ro.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [scrollRef, scheduleFollow, setStick]);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      const el = scrollRef.current;
      if (!el) return;
      setStick(true);
      if (behavior === 'auto') {
        el.scrollTop = el.scrollHeight;
      } else {
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      }
    },
    [scrollRef, setStick],
  );

  const followContent = useCallback(
    (behavior: ScrollBehavior = 'auto') => {
      if (!stickRef.current) return;
      if (behavior === 'smooth') {
        scrollToBottom('smooth');
        return;
      }
      scheduleFollow();
    },
    [scheduleFollow, scrollToBottom],
  );

  const jumpToBottomAndFollow = useCallback(() => {
    scrollToBottom('smooth');
  }, [scrollToBottom]);

  /**
   * Send path: pin now, then again after the next two frames, so the pin
   * lands after the new message and the shrunk composer are laid out.
   */
  const enableStickToBottom = useCallback(() => {
    scrollToBottom('auto');
    requestAnimationFrame(() =>
      requestAnimationFrame(() => pinToBottom()),
    );
  }, [scrollToBottom, pinToBottom]);

  return {
    stickToBottom,
    showJumpToBottom,
    followContent,
    jumpToBottomAndFollow,
    enableStickToBottom,
  };
}
