import { FINDING_CLAIM_MAX_CHARS, FINDING_EVIDENCE_MAX_CHARS } from '@agent/agent-models';

import type { Tool } from './types';

/**
 * Records one fact about the workspace into this run's task record (task
 * state reduces it from the call; the harness card shows the record every
 * step). A recorded fact is research evidence: it stands for the reads it
 * came from, so those reads can leave the prompt without being read again,
 * and the answer is written from the record.
 */
export const record_finding: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'record_finding',
      description:
        'Record one confirmed fact for this task: a short claim and its evidence. Recorded findings are kept for the rest of the run, so the file reads behind them can leave the prompt and you will not need to read them again. Record facts as you confirm them; write your answer from them.',
      parameters: {
        type: 'object',
        properties: {
          claim: {
            type: 'string',
            description: `The fact, in one sentence, with exact strings quoted (max ${FINDING_CLAIM_MAX_CHARS} chars).`,
          },
          evidence: {
            type: 'string',
            description: `Where it is: path:line (several separated by ";"), a URL, or the exact quoted text (max ${FINDING_EVIDENCE_MAX_CHARS} chars).`,
          },
          topic: {
            type: 'string',
            description: 'Optional: which part of the request it answers (e.g. a section name).',
          },
        },
        required: ['claim', 'evidence'],
        additionalProperties: false,
      },
    },
  },
  guidance: {
    whenToUse: ['You confirmed a fact the answer needs, from a file you read or a result you saw.'],
    whenNotToUse: ['The fact is a guess, or you have not seen its evidence yet.'],
    usage: [
      'One fact per call; several calls in one turn are fine.',
      'Evidence is path:line from the read or grep result, not from memory.',
    ],
  },
  risk: 'read',
  // Runs with the first batch and is not a read: recording does not count
  // toward serial-read advice.
  stage: 'skill',
  execute: async (args) => {
    const claim = typeof args.claim === 'string' ? args.claim.trim() : '';
    const evidence = typeof args.evidence === 'string' ? args.evidence.trim() : '';
    if (!claim || !evidence) return 'Error: record_finding needs both "claim" and "evidence".';
    const cut = claim.length > FINDING_CLAIM_MAX_CHARS || evidence.length > FINDING_EVIDENCE_MAX_CHARS;
    return cut ? 'Recorded (shortened to the size limits).' : 'Recorded.';
  },
};
