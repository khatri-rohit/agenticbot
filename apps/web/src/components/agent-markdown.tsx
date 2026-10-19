'use client';

import { useMemo } from 'react';
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
    <ul className="mt-2 flex flex-wrap gap-1.5">
      {citations.map((citation) => (
        <li key={`${citation.path}:${citation.start}:${citation.end}`}>
          <button
            type="button"
            className="type-ui rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
            title={`Copy ${citation.path}`}
            onClick={() => void navigator.clipboard.writeText(citation.path)}
          >
            {fileNameFromPath(citation.path)}:{citation.start}–{citation.end}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function AgentMarkdown({
  content,
  streaming = false,
}: {
  content: string;
  streaming?: boolean;
}) {
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
          animated={STREAM_ANIMATION}
          caret="circle"
          isAnimating
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
