'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Streamdown } from 'streamdown';
import { code } from '@streamdown/code';
import { mermaid } from '@streamdown/mermaid';
import { useTheme } from '@/components/shell/theme-provider';
import type { ThemeScheme } from '@/components/shell/theme-presets';
import {
  extractFileCitations,
  isReportBanner,
  normalizeAssistantMarkdown,
  rewriteCitationFences,
} from './normalize-assistant-markdown';

/**
 * One plugin set for both modes: swapping plugins when streaming finishes
 * re-runs Shiki on every settled block (finish-line flash).
 */
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

function mermaidTheme(scheme: ThemeScheme): 'dark' | 'default' {
  return scheme === 'light' ? 'default' : 'dark';
}

/**
 * Streamdown enables link-safety by default (full-screen confirm modal).
 * Source citations should open normally in a new tab.
 * @see https://streamdown.ai/docs — `linkSafety`
 */
const linkSafety = { enabled: false };

/**
 * Assistant output is untrusted web content: prompt-injected images and links
 * are the documented Streamdown threat. Keep rehype-harden's default protocol
 * allow-list; restrict rendered images to local/HTTPS origins and drop data
 * URIs (a data:image payload can smuggle content past CSP img-src).
 * @see https://streamdown.ai/docs/features/security
 */
const hardenImages = {
  image: {
    enabled: true,
    origins: ['self', 'https:'],
    allowDataImages: false,
  },
};

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
export const AgentMarkdown = memo(function AgentMarkdown({
  content,
  streaming = false,
}: {
  content: string;
  streaming?: boolean;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const { scheme } = useTheme();
  const citations = useMemo(() => extractFileCitations(content), [content]);
  const markdown = useMemo(
    () => normalizeAssistantMarkdown(rewriteCitationFences(content)),
    [content],
  );
  const containerRef = useRef<HTMLDivElement>(null);

  // Streamdown sanitizes HTML, so banner headings cannot be marked in the
  // markdown; mark them after the markdown changes. Styled in global.css.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    for (const heading of root.querySelectorAll('h2, h3, h4')) {
      heading.classList.toggle(
        'report-banner',
        isReportBanner(heading.textContent ?? ''),
      );
    }
  }, [markdown, scheme]);

  if (!markdown) return null;

  // Mermaid reads its theme once per render of a diagram; remount on a
  // theme switch so diagrams follow. Only when a diagram is present, since a
  // remount re-runs Shiki on every code block.
  const themeKey = markdown.includes('```mermaid') ? scheme : undefined;

  const shared = {
    shikiTheme: SHIKI_THEMES,
    lineNumbers: true,
    codeBlockMaxHeight: 0,
    controls,
    className: 'agent-markdown',
    linkSafety,
    harden: hardenImages,
    mermaid: { config: { theme: mermaidTheme(scheme) } },
  };

  if (streaming) {
    return (
      <div className="min-w-0" ref={containerRef}>
        <Streamdown
          key={themeKey}
          {...shared}
          mode="streaming"
          // Text appears as it arrives. A per-word fade made replies ripple
          // in; the caret alone says it is still streaming.
          animated={false}
          caret={reducedMotion ? undefined : 'circle'}
          parseIncompleteMarkdown
          plugins={fullPlugins}
        >
          {markdown}
        </Streamdown>
        <CitationChips citations={citations} />
      </div>
    );
  }

  return (
    <div className="min-w-0" ref={containerRef}>
      <Streamdown
        key={themeKey}
        {...shared}
        mode="static"
        plugins={fullPlugins}
      >
        {markdown}
      </Streamdown>
      <CitationChips citations={citations} />
    </div>
  );
});
