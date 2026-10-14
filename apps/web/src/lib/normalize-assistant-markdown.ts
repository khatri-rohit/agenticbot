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
