import express, { Router, type Request, type Response } from 'express';

const router = Router();

const SPEACHES_BASE_URL = (
  process.env.SPEACHES_BASE_URL ?? 'http://127.0.0.1:8000'
).replace(/\/$/, '');
const SPEACHES_STT_MODEL =
  process.env.SPEACHES_STT_MODEL ?? 'Systran/faster-distil-whisper-large-v3';
const VOICE_STT_LANGUAGE = process.env.VOICE_STT_LANGUAGE ?? 'en';
const VOICE_STT_PROMPT = (
  process.env.VOICE_STT_PROMPT ??
  'desk, Speaches, Nx monorepo, Ollama, agent-core, RunManager, ChatInput'
).trim();
const MAX_AUDIO_BYTES = Number(process.env.VOICE_MAX_AUDIO_BYTES ?? 10_485_760);

/**
 * POST /api/voice/transcribe
 * Body: raw audio bytes (Content-Type: audio/webm, audio/wav, …)
 * Returns: { text: string }
 *
 * Proxies to Speaches OpenAI-compatible /v1/audio/transcriptions.
 * Does not touch Ollama or agent-core.
 */
router.post(
  '/transcribe',
  express.raw({
    type: (req) => {
      const ct = req.headers['content-type'] ?? '';
      return ct.startsWith('audio/') || ct === 'application/octet-stream';
    },
    limit: MAX_AUDIO_BYTES,
  }),
  async (req: Request, res: Response) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return res.status(400).json({ error: 'audio body is required' });
    }
    if (body.length > MAX_AUDIO_BYTES) {
      return res.status(413).json({ error: 'audio too large' });
    }

    const contentType =
      typeof req.headers['content-type'] === 'string' &&
      req.headers['content-type'].startsWith('audio/')
        ? req.headers['content-type'].split(';')[0]?.trim()
        : 'audio/webm';
    const ext = contentType.includes('wav')
      ? 'wav'
      : contentType.includes('mpeg') || contentType.includes('mp3')
        ? 'mp3'
        : 'webm';

    try {
      const form = new FormData();
      form.append(
        'file',
        new Blob([new Uint8Array(body)], { type: contentType }),
        `audio.${ext}`,
      );
      form.append('model', SPEACHES_STT_MODEL);
      form.append('response_format', 'json');
      form.append('language', VOICE_STT_LANGUAGE);
      if (VOICE_STT_PROMPT) form.append('prompt', VOICE_STT_PROMPT);

      const upstream = await fetch(
        `${SPEACHES_BASE_URL}/v1/audio/transcriptions`,
        {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(30_000),
        },
      );

      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => '');
        console.error(
          '[voice] speaches error',
          upstream.status,
          detail.slice(0, 500),
        );
        return res.status(502).json({
          error: 'Speech service failed',
          status: upstream.status,
        });
      }

      const data = (await upstream.json()) as { text?: string };
      return res.json({ text: (data.text ?? '').trim() });
    } catch (err) {
      console.error('[voice] speaches unreachable', err);
      return res.status(503).json({ error: 'Voice service unavailable' });
    }
  },
);

export { router as voiceRouter };
