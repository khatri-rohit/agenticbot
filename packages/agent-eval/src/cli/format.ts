/** Plain-text table: header row, then rows, columns padded to width. */
export function table(header: string[], rows: string[][]): string {
  const widths = header.map((cell, i) =>
    Math.max(cell.length, ...rows.map((row) => (row[i] ?? '').length)),
  );
  const line = (row: string[]) =>
    row.map((cell, i) => (cell ?? '').padEnd(widths[i]!)).join('  ').trimEnd();
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

export function tokens(value: number | undefined): string {
  if (value === undefined) return '-';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

export function duration(ms: number | undefined): string {
  if (ms === undefined) return '-';
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
}

export function percent(ratio: number | null | undefined): string {
  return ratio === null || ratio === undefined ? '-' : `${Math.round(ratio * 100)}%`;
}
