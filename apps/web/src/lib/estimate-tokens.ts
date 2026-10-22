/**
 * Draft / composer delta only. Full request envelopes are estimated
 * server-side (system + tools + history) via POST /api/agent/context/estimate.
 */

import {
  CHARS_PER_TOKEN,
  ESTIMATED_TOKENS_PER_IMAGE,
} from '@agent/agent-models';

export function estimateDraftTokens(
  text: string | null | undefined,
  pendingImages = 0,
): number {
  let tokens = 0;
  if (text) tokens += Math.ceil(text.length / CHARS_PER_TOKEN);
  tokens += pendingImages * ESTIMATED_TOKENS_PER_IMAGE;
  return tokens;
}
