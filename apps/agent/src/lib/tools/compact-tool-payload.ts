/** Keep tool output small enough for Ollama context (see chatpipline). */
const MARKDOWN_PER_DOC = 5_000;
export const MAX_TOOL_PAYLOAD_CHARS = 80_000;

type ScrapedDoc = {
  url?: string;
  title?: string;
  markdown?: string;
  metadata?: { title?: string; description?: string };
};

function compactDoc(doc: ScrapedDoc) {
  const markdown = doc.markdown ?? '';
  const truncated = markdown.length > MARKDOWN_PER_DOC;
  return {
    url: doc.url,
    title: doc.metadata?.title ?? doc.title,
    description: doc.metadata?.description,
    markdown: truncated
      ? `${markdown.slice(0, MARKDOWN_PER_DOC)}\n…[truncated]`
      : markdown,
  };
}

function collectDocs(payload: unknown): ScrapedDoc[] {
  if (!payload || typeof payload !== 'object') return [];
  const root = payload as Record<string, unknown>;
  const docs: ScrapedDoc[] = [];

  if (Array.isArray(root.data)) {
    docs.push(...(root.data as ScrapedDoc[]));
  }
  for (const key of ['web', 'news']) {
    const chunk = root[key];
    if (Array.isArray(chunk)) docs.push(...(chunk as ScrapedDoc[]));
  }
  if (docs.length === 0 && root.data && typeof root.data === 'object') {
    for (const value of Object.values(root.data as Record<string, unknown>)) {
      if (Array.isArray(value)) docs.push(...(value as ScrapedDoc[]));
    }
  }
  return docs;
}

export function compactToolPayload(payload: unknown): string {
  if (typeof payload === 'string') {
    return payload.length > MAX_TOOL_PAYLOAD_CHARS
      ? `${payload.slice(0, MAX_TOOL_PAYLOAD_CHARS)}\n…[truncated]`
      : payload;
  }

  const docs = collectDocs(payload);
  if (docs.length === 0) {
    const raw = JSON.stringify(payload);
    return raw.length > MAX_TOOL_PAYLOAD_CHARS
      ? `${raw.slice(0, MAX_TOOL_PAYLOAD_CHARS)}\n…[truncated]`
      : raw;
  }

  const body = {
    results: docs.map(compactDoc),
    warning:
      typeof (payload as { warning?: unknown }).warning === 'string'
        ? (payload as { warning: string }).warning
        : undefined,
    error:
      typeof (payload as { error?: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : undefined,
  };

  let text = JSON.stringify(body, null, 2);
  if (text.length > MAX_TOOL_PAYLOAD_CHARS) {
    const tighter = {
      ...body,
      results: body.results.map((r) => ({
        ...r,
        markdown: r.markdown.slice(0, 1_500),
      })),
    };
    text = JSON.stringify(tighter, null, 2);
  }
  if (text.length > MAX_TOOL_PAYLOAD_CHARS) {
    text = `${text.slice(0, MAX_TOOL_PAYLOAD_CHARS)}\n…[truncated]`;
  }
  return text;
}
