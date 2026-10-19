export type FileCitation = {
  start: number;
  end: number;
  path: string;
};

function citationFenceRe(): RegExp {
  return /```(\d+):(\d+):([^\n`]+)/g;
}

const EXT_TO_LANG: Record<string, string> = {
  ts: 'ts',
  tsx: 'tsx',
  js: 'js',
  jsx: 'jsx',
  mjs: 'js',
  cjs: 'js',
  py: 'python',
  rs: 'rust',
  go: 'go',
  json: 'json',
  md: 'markdown',
  css: 'css',
  scss: 'scss',
  html: 'html',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'bash',
  bash: 'bash',
  toml: 'toml',
  sql: 'sql',
};

/** Parse ```start:end:path fences the model emits for file-range citations. */
export function extractFileCitations(markdown: string): FileCitation[] {
  const seen = new Set<string>();
  const citations: FileCitation[] = [];
  for (const match of markdown.matchAll(citationFenceRe())) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    const path = match[3].trim();
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 1 ||
      end < start ||
      !path
    ) {
      continue;
    }
    const key = `${path}:${start}:${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({ start, end, path });
  }
  return citations;
}

/** Rewrite citation fence languages to the file extension so Shiki can highlight. */
export function rewriteCitationFences(markdown: string): string {
  return markdown.replace(
    citationFenceRe(),
    (_all, _start: string, _end: string, rawPath: string) => {
      const path = rawPath.trim();
      const dot = path.lastIndexOf('.');
      const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
      const lang = EXT_TO_LANG[ext] ?? ext;
      return `\`\`\`${lang}`;
    },
  );
}

/**
 * Light cleanup for common model markdown mistakes before Streamdown renders.
 */
export function normalizeAssistantMarkdown(markdown: string): string {
  const mermaidFixed = markdown.replace(
    /```mermaid\n([\s\S]*?)```/g,
    (_, body: string) => {
      const chart = normalizeMermaidBody(body.trim());
      return `\`\`\`mermaid\n${chart}\n\`\`\``;
    },
  );
  return promoteStandaloneBoldLines(mermaidFixed);
}

/**
 * Models often emit `**Article 1: Title**` as a lone line instead of a heading.
 * Promote those to h3 so the chat layout can space them as section labels.
 */
function promoteStandaloneBoldLines(markdown: string): string {
  const lines = markdown.split('\n');
  let inFence = false;

  return lines
    .map((line) => {
      const trimmedStart = line.trimStart();
      if (trimmedStart.startsWith('```')) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      if (/^\s{0,3}([-*+]|\d+[.)])\s/.test(line)) return line;

      const match = /^(?:[ \t]*)(?:\*\*(.+?)\*\*|__(.+?)__)[ \t]*$/.exec(line);
      if (!match) return line;

      const title = (match[1] ?? match[2]).trim();
      if (title.length < 2 || title.length > 90) return line;
      if (/[.!?]$/.test(title)) return line;
      return `### ${title}`;
    })
    .join('\n');
}

/** e.g. `flowchart A --> B` → `flowchart TD` + `A --> B` */
function normalizeMermaidBody(chart: string): string {
  if (!chart) return chart;

  if (/^flowchart\s+(?!TD|LR|BT|RL\b)/i.test(chart)) {
    chart = chart.replace(/^flowchart\s+/i, 'flowchart TD\n');
  }
  if (/^graph\s+(?!TD|LR|BT|RL\b)/i.test(chart)) {
    chart = chart.replace(/^graph\s+/i, 'graph TD\n');
  }

  return chart;
}
