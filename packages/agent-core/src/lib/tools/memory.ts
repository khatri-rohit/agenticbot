import type { ProposedMemoryOp, ToolContext } from '@agenticbot/agent-models';
import { DEFAULT_MEMORY_CAPS } from '@agenticbot/agent-models';
import type { MemoryFiles } from '@agenticbot/agent-models';

import { gateMemoryOps } from '../memory/gate';
import type { Tool } from './type';

export type MemoryToolStore = {
  read: () => Promise<MemoryFiles>;
  apply: (op: ProposedMemoryOp) => Promise<{ id: string }>;
  stage: (op: ProposedMemoryOp) => Promise<{ id: string }>;
  source: (ctx: ToolContext) => { threadId: string; seq: number };
};

/**
 * Foreground memory tool. Gate is deterministic in core; host persists.
 * Skills / external evidence / review edits to USER.md are staged, not applied.
 */
export function createMemoryTool(store: MemoryToolStore): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'memory',
        description:
          'Save, patch, or remove a durable fact in USER.md (who the user is, global) or MEMORY.md (notes). On a workspace run, notes are this folder only — they do not leak to other folders. Use when the user says remember, from now on, I prefer, or don\'t forget. One fact per call. Do not store secrets.',
        parameters: {
          type: 'object',
          properties: {
            target: {
              type: 'string',
              enum: ['user', 'notes'],
              description:
                'user = USER.md profile facts (all threads). notes = MEMORY.md: this folder on workspace runs, global on Home.',
            },
            action: {
              type: 'string',
              enum: ['add', 'patch', 'remove'],
            },
            content: {
              type: 'string',
              description: 'New text for add or patch.',
            },
            oldText: {
              type: 'string',
              description: 'Exact unique span to patch or remove.',
            },
            reason: {
              type: 'string',
              description: 'One line: why this should persist across threads.',
            },
          },
          required: ['target', 'action', 'reason'],
          additionalProperties: false,
        },
      },
    },
    guidance: {
      whenToUse: [
        'The user says remember, from now on, I prefer, don\'t forget, or states a durable profile fact.',
        'A convention or environment fact should survive this thread.',
        'On a workspace run, a lesson that should apply the next time this folder is open.',
      ],
      whenNotToUse: [
        'Ordinary chat that is only true for this question.',
        'Secrets, API keys, passwords, or tokens.',
        'Project-file edits — that is not this tool.',
        'Facts that belong in another folder — notes are scoped to the open workspace.',
      ],
      usage: [
        'Call memory with target notes for lessons and environment (this folder on workspace); target user for who they are.',
        'One fact per call. Keep content short. Reason is one line.',
        'For patch/remove, oldText must match an exact unique span already in the file.',
      ],
    },
    risk: 'write',
    execute: async (args, ctx) => {
      const target = args.target === 'user' ? 'user' : 'notes';
      const action =
        args.action === 'patch' || args.action === 'remove'
          ? args.action
          : 'add';
      const proposed: ProposedMemoryOp = {
        target,
        action,
        content: typeof args.content === 'string' ? args.content : undefined,
        oldText: typeof args.oldText === 'string' ? args.oldText : undefined,
        reason:
          typeof args.reason === 'string' && args.reason.trim()
            ? args.reason.trim()
            : '',
        source: store.source(ctx),
        by: 'foreground',
        evidence: 'user-said',
      };

      const current = await store.read();
      const [gated] = gateMemoryOps(current, [proposed], DEFAULT_MEMORY_CAPS);
      if (!gated) return 'Memory gate returned no verdict.';

      if (gated.verdict === 'reject') {
        return `Rejected: ${gated.why}`;
      }
      if (gated.verdict === 'stage') {
        const staged = await store.stage(proposed);
        return `Staged (${gated.why}). op=${staged.id}. Not in the prompt until approved.`;
      }

      const applied = await store.apply(proposed);
      const file = target === 'user' ? 'USER.md' : 'MEMORY.md';
      return `Applied to ${file}. op=${applied.id}. Visible on the next run. Revert with that id.`;
    },
  };
}
