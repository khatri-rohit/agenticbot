const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3333';

/** Transcribe a recorded audio blob via apps/api → Speaches. */
export async function transcribeAudio(blob: Blob): Promise<string> {
  const res = await fetch(`${API_BASE}/api/voice/transcribe`, {
    method: 'POST',
    headers: {
      'Content-Type': blob.type || 'audio/webm',
    },
    body: blob,
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(err?.error ?? `Transcription failed (${res.status})`);
  }

  const data = (await res.json()) as { text?: string };
  return (data.text ?? '').trim();
}
