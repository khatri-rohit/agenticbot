export function tokens(value: number | undefined | null): string {
  if (value === undefined || value === null) return '–';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

export function duration(ms: number | undefined | null): string {
  if (ms === undefined || ms === null) return '–';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
}

export function percent(ratio: number | null | undefined): string {
  return ratio === null || ratio === undefined ? '–' : `${Math.round(ratio * 100)}%`;
}

export function when(iso: string | undefined): string {
  return iso ? iso.slice(0, 16).replace('T', ' ') : '–';
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
