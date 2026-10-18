'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const BOTTOM_THRESHOLD_PX = 96;

export function useStickToBottom(
  scrollRef: React.RefObject<HTMLElement | null>,
) {
  const [stickToBottom, setStickToBottom] = useState(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const stickRef = useRef(true);
  const rafRef = useRef(0);

  const syncStickFromScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom <= BOTTOM_THRESHOLD_PX;
    stickRef.current = atBottom;
    setStickToBottom(atBottom);
    setShowJumpToBottom(!atBottom);
  }, [scrollRef]);

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

    const onScroll = () => syncStickFromScroll();
    el.addEventListener('scroll', onScroll, { passive: true });

    const ro = new ResizeObserver(() => scheduleFollow());
    ro.observe(el);
    const content = el.firstElementChild;
    if (content) ro.observe(content);

    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [scrollRef, scheduleFollow, syncStickFromScroll]);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      const el = scrollRef.current;
      if (!el) return;
      if (behavior === 'auto') {
        el.scrollTop = el.scrollHeight;
      } else {
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      }
      stickRef.current = true;
      setStickToBottom(true);
      setShowJumpToBottom(false);
    },
    [scrollRef],
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

  const enableStickToBottom = useCallback(() => {
    stickRef.current = true;
    setStickToBottom(true);
    scrollToBottom('auto');
  }, [scrollToBottom]);

  return {
    stickToBottom,
    showJumpToBottom,
    followContent,
    jumpToBottomAndFollow,
    enableStickToBottom,
  };
}
