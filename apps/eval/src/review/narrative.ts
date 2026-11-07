import { parseReviewNarrative, type ReviewNarrative } from '@agent/agent-models';

import type { ReviewModelInput } from '@agent/agent-eval';

const DEFAULT_CLOUD_BASE_URL = 'https://ollama.com/v1';
const REVIEW_TIMEOUT_MS = 20_000;

const SYSTEM_PROMPT = `You are a run reviewer for a personal-assistant agent harness.

You receive a deterministic digest of a thread (and optionally one focused run) plus at most five short excerpts. You do not have the raw trace. The digest is the source of truth.

Rules:
- Cite only facts that appear in the digest or excerpts. Quote numbers exactly.
- Do not invent tools, files, outcomes, user intent, or findings that the digest does not support.
- Do not flatter. If the digest shows waste, over-work, or a misread, say so plainly. If it shows good work, say so without praise inflation.
- If the digest is incomplete, say what is missing instead of guessing.
- Reply with strict JSON only, no markdown, matching:
  {"summary": string, "alignment": string, "findings": [{"kind": "over-work"|"unnecessary-calls"|"misread-intent"|"waste"|"good", "text": string}], "suggestions": string[]}
- summary is 3–6 sentences. Each finding cites at least one digest number or excerpt.
- Keep suggestions concrete and tied to the findings.`;

function reviewModel(threadModel: string): string | null {
  const configured = process.env.REVIEW_MODEL?.trim();
  const model = configured || threadModel.trim();
  return model || null;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced?.[1] ?? trimmed).trim();
  return JSON.parse(raw) as unknown;
}

/**
 * One non-streaming completion over the digest. Failures return null so the
 * host can store a digest-only review (same pattern as title generation).
 */
export async function generateNarrative(
  input: ReviewModelInput,
  threadModel: string,
): Promise<ReviewNarrative | null> {
  const model = reviewModel(threadModel);
  if (!model) return null;

  const baseURL = (process.env.OLLAMA_BASE_URL ?? DEFAULT_CLOUD_BASE_URL).replace(/\/$/, '');
  const usingCloudDefault = baseURL === DEFAULT_CLOUD_BASE_URL;
  if (usingCloudDefault && !process.env.OLLAMA_API_KEY) return null;

  const user = JSON.stringify(
    {
      digest: input.digest,
      excerpts: input.excerpts,
    },
    null,
    2,
  );

  try {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OLLAMA_API_KEY ?? 'ollama'}`,
      },
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: 1200,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(REVIEW_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error('[review] narrative failed:', response.status, await response.text());
      return null;
    }
    const body = (await response.json()) as {
      choices?: { message?: { content?: string | null } }[];
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) return null;
    return parseReviewNarrative(extractJson(content));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[review] narrative failed:', message);
    return null;
  }
}
