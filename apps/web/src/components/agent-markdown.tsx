'use client';

import { useMemo } from 'react';
import { Streamdown } from 'streamdown';
import { code } from '@streamdown/code';
import { mermaid } from '@streamdown/mermaid';
import { normalizeAssistantMarkdown } from '../lib/normalize-assistant-markdown';

const codePlugins = { code };
const fullPlugins = { code, mermaid };

/** Streamdown / Shiki defaults — dark theme via `html.dark`. */
const SHIKI_THEMES: ['github-light', 'github-dark'] = [
  'github-light',
  'github-dark',
];

const controls = {
  code: { copy: true, download: false },
  mermaid: {
    copy: true,
    download: false,
    fullscreen: true,
    panZoom: true,
  },
} as const;

function mermaidTheme(): 'dark' | 'default' {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.classList.contains('light')
    ? 'default'
    : 'dark';
}

/** Word-level stagger: readable cadence, catches up if the SSE buffer runs ahead. */
const STREAM_ANIMATION = {
  animation: 'fadeIn' as const,
  duration: 170,
  easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
  sep: 'word' as const,
  stagger: 28,
  maxBacklogMs: 260,
};

/**
 * Streamdown enables link-safety by default (full-screen confirm modal).
 * Source citations should open normally in a new tab.
 * @see https://streamdown.ai/docs — `linkSafety`
 */
const linkSafety = { enabled: false };

/**
 * Renders assistant markdown via Streamdown.
 * Use `streaming` while tokens are arriving so incomplete fences parse correctly.
 */
export function AgentMarkdown({
  content,
  streaming = false,
}: {
  content: string;
  streaming?: boolean;
}) {
  const markdown = useMemo(
    () => normalizeAssistantMarkdown(content),
    [content],
  );

  if (!markdown) return null;

  const shared = {
    shikiTheme: SHIKI_THEMES,
    lineNumbers: true,
    codeBlockMaxHeight: 0,
    controls,
    className: 'agent-markdown',
    linkSafety,
  };

  if (streaming) {
    return (
      <Streamdown
        {...shared}
        mode="streaming"
        animated={STREAM_ANIMATION}
        caret="circle"
        isAnimating
        parseIncompleteMarkdown
        plugins={codePlugins}
      >
        {markdown}
      </Streamdown>
    );
  }

  return (
    <Streamdown
      {...shared}
      mode="static"
      plugins={fullPlugins}
      mermaid={{ config: { theme: mermaidTheme() } }}
    >
      {markdown}
    </Streamdown>
  );
}
