'use client';

import { useEffect, useMemo, useState } from 'react';
import { Streamdown } from 'streamdown';
import { code } from '@streamdown/code';
import { mermaid } from '@streamdown/mermaid';
import {
  extractFileCitations,
  normalizeAssistantMarkdown,
  rewriteCitationFences,
} from '../lib/normalize-assistant-markdown';

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

/** Faster word cadence so a fast SSE buffer does not feel like a carousel. */
const STREAM_ANIMATION = {
  animation: 'fadeIn' as const,
  duration: 100,
  easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
  sep: 'word' as const,
  stagger: 12,
  maxBacklogMs: 220,
};

/**
 * Streamdown enables link-safety by default (full-screen confirm modal).
 * Source citations should open normally in a new tab.
 * @see https://streamdown.ai/docs — `linkSafety`
 */
const linkSafety = { enabled: false };

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  return reduced;
}

function fileNameFromPath(path: string): string {
  const parts = path.replaceAll('\\', '/').split('/').filter(Boolean);
  return parts.at(-1) ?? path;
}

function CitationChips({
  citations,
}: {
  citations: ReturnType<typeof extractFileCitations>;
}) {
  if (citations.length === 0) return null;
  return (
    <ul className="mt-2.5 flex flex-wrap gap-1.5" translate="no">
      {citations.map((citation) => {
        const label = `${fileNameFromPath(citation.path)}:${citation.start}–${citation.end}`;
        return (
          <li key={`${citation.path}:${citation.start}:${citation.end}`}>
            <button
              type="button"
              className="type-caption rounded-md bg-muted/40 px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
              title={`Copy ${citation.path}`}
              aria-label={`Copy path ${citation.path}`}
              onClick={() => void navigator.clipboard.writeText(citation.path)}
            >
              {label}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

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
  const reducedMotion = usePrefersReducedMotion();
  const citations = useMemo(() => extractFileCitations(content), [content]);
  const markdown = useMemo(
    () => normalizeAssistantMarkdown(rewriteCitationFences(content)),
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
      <div className="min-w-0">
        <Streamdown
          {...shared}
          mode="streaming"
          animated={reducedMotion ? false : STREAM_ANIMATION}
          caret={reducedMotion ? undefined : 'circle'}
          isAnimating={!reducedMotion}
          parseIncompleteMarkdown
          plugins={codePlugins}
        >
          {markdown}
        </Streamdown>
        <CitationChips citations={citations} />
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <Streamdown
        {...shared}
        mode="static"
        plugins={fullPlugins}
        mermaid={{ config: { theme: mermaidTheme() } }}
      >
        {markdown}
      </Streamdown>
      <CitationChips citations={citations} />
    </div>
  );
}
