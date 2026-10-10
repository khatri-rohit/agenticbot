const HALLUCINATION_RE =
  /\b(thanks for watching|thank you for watching|like and subscribe|subscribe)\b/i;

/** Drop Whisper junk from silence / noise (pipe spam, YouTube-style captions). */
export function isUsableTranscript(text: string): boolean {
  const t = text.trim();
  if (!t) return false;

  const compact = t.replace(/\s+/g, '');
  const bars = (compact.match(/\|/g) ?? []).length;
  if (compact.length > 0 && bars / compact.length > 0.4) return false;

  const letters = (t.match(/[A-Za-z]/g) ?? []).length;
  if (letters < 3) return false;

  // Caption hallucinations are often the whole segment.
  if (HALLUCINATION_RE.test(t) && letters < 80) return false;

  return true;
}

/** Append a transcript piece after any existing composer text. */
export function appendComposerText(prev: string, piece: string): string {
  const next = piece.trim();
  if (!next) return prev;
  const base = prev.trimEnd();
  return base ? `${base} ${next}` : next;
}
