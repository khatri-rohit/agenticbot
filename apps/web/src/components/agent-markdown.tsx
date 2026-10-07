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

const mermaidConfig = { config: { theme: 'dark' as const } };

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
  };

  if (streaming) {
    return (
      <Streamdown
        {...shared}
        mode="streaming"
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
      mermaid={mermaidConfig}
    >
      {markdown}
    </Streamdown>
  );
}
