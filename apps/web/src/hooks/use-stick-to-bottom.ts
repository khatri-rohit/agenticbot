'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const BOTTOM_THRESHOLD_PX = 80;

export function useStickToBottom(
  scrollRef: React.RefObject<HTMLElement | null>,
) {
  const [stickToBottom, setStickToBottom] = useState(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const stickRef = useRef(true);

  const syncStickFromScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom <= BOTTOM_THRESHOLD_PX;
    stickRef.current = atBottom;
    setStickToBottom(atBottom);
    setShowJumpToBottom(!atBottom);
  }, [scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onScroll = () => syncStickFromScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scrollRef, syncStickFromScroll]);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      const el = scrollRef.current;
      if (!el) return;
      el.scrollTo({ top: el.scrollHeight, behavior });
      stickRef.current = true;
      setStickToBottom(true);
      setShowJumpToBottom(false);
    },
    [scrollRef],
  );

  const followContent = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      if (!stickRef.current) return;
      scrollToBottom(behavior);
    },
    [scrollToBottom],
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
