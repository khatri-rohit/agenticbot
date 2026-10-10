const HALLUCINATION_RE =
  /\b(thanks for watching|thank you for watching|like and subscribe|subscribe)\b/i;

/** Drop Whisper junk from silence / noise (pipe spam, YouTube-style captions). */
export function isUsableTranscript(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const compact = trimmed.replace(/\s+/g, '');
  const bars = (compact.match(/\|/g) ?? []).length;
  if (compact.length > 0 && bars / compact.length > 0.4) return false;

  const letters = (trimmed.match(/[A-Za-z]/g) ?? []).length;
  if (letters < 3) return false;

  // Caption hallucinations are often the whole segment.
  if (HALLUCINATION_RE.test(trimmed) && letters < 80) return false;

  return true;
}
