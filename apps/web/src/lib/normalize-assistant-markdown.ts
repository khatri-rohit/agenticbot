/**
 * Light cleanup for common model markdown mistakes before Streamdown renders.
 */
export function normalizeAssistantMarkdown(markdown: string): string {
  return markdown.replace(/```mermaid\n([\s\S]*?)```/g, (_, body: string) => {
    const chart = normalizeMermaidBody(body.trim());
    return `\`\`\`mermaid\n${chart}\n\`\`\``;
  });
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
