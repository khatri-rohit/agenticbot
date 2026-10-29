import type { Tool } from './type';

export const RECALL_MAX_CHARS = 8_000;

/**
 * Read back a stored body by sha256: an evicted tool result card, a sub-agent
 * report, or a large ledger blob. Eviction is only safe because this exists.
 */
export const recall: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'recall',
      description:
        'Read a stored result by its sha256 (from an "(evicted)" card, a sub-agent report, or a blob note). Returns up to 8000 chars per call.',
      parameters: {
        type: 'object',
        properties: {
          sha256: { type: 'string', description: 'The 64-char sha256 from the card.' },
          offset: { type: 'integer', description: 'Char offset to start from. Default 0.' },
          limit: { type: 'integer', description: 'Max chars (≤ 8000). Default 8000.' },
        },
        required: ['sha256'],
        additionalProperties: false,
      },
    },
  },
  guidance: {
    whenToUse: ['You need the full text behind an evicted card or a sub-agent report sha.'],
    whenNotToUse: ['The file may have changed since — re-read it with read_file instead.'],
    usage: ['Page long bodies with offset; prefer the slice you need.'],
  },
  risk: 'read',
  stage: 'read',
  execute: async (args, ctx) => {
    const sha = typeof args.sha256 === 'string' ? args.sha256.trim().toLowerCase() : '';
    if (!/^[a-f0-9]{64}$/.test(sha)) return 'Error: sha256 must be 64 hex chars.';
    if (!ctx.readBlob) return 'Error: no stored results in this run.';
    const offset =
      typeof args.offset === 'number' && args.offset > 0 ? Math.floor(args.offset) : 0;
    const limit =
      typeof args.limit === 'number' && args.limit > 0
        ? Math.min(Math.floor(args.limit), RECALL_MAX_CHARS)
        : RECALL_MAX_CHARS;
    let body: string;
    try {
      body = await ctx.readBlob(sha, offset, limit + 1);
    } catch {
      return `Error: nothing stored under sha256:${sha}.`;
    }
    if (body.length > limit) {
      return `${body.slice(0, limit)}\n\n(more: recall offset=${offset + limit})`;
    }
    return body;
  },
};
