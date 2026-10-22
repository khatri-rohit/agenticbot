import type { ApprovalOption } from '@agent/agent-models';

import type { Tool } from './type';

function parseOptions(raw: unknown): ApprovalOption[] {
  if (!Array.isArray(raw)) return [];
  const options: ApprovalOption[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const label = typeof record.label === 'string' ? record.label.trim() : '';
    if (!id || !label) continue;
    options.push({ id, label });
  }
  return options;
}

/**
 * Blocking preference / one-way-door question. The host pauses until a human
 * picks an option; there is no default choice in chat.
 */
export const ask_user: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'ask_user',
      description:
        'Ask the human a blocking question with at least two labeled options. Use for irreversible choices or preferences you cannot infer. The run pauses until they pick.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The question to show the human.',
          },
          options: {
            type: 'array',
            minItems: 2,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Stable option id.' },
                label: {
                  type: 'string',
                  description: 'Short label shown on the button.',
                },
              },
              required: ['id', 'label'],
              additionalProperties: false,
            },
            description: 'At least two distinct options.',
          },
        },
        required: ['question', 'options'],
        additionalProperties: false,
      },
    },
  },
  risk: 'external',
  guidance: {
    whenToUse: [
      'A one-way door: destructive command, conflicting approaches, or a preference you cannot infer from the thread.',
    ],
    whenNotToUse: [
      'Do not ask for permission to edit or run — those tools run without a pause.',
      'Do not use for trivia you can answer, or for questions with a single obvious next step.',
    ],
    usage: [
      'Pass a short question and at least two options with stable ids.',
      'After the tool returns, follow the chosen option. Do not silently pick a different path.',
    ],
  },
  execute: async (args, ctx) => {
    const question = String(args.question ?? '').trim();
    const options = parseOptions(args.options);
    if (!question) {
      return 'ask_user requires a non-empty question.';
    }
    if (options.length < 2) {
      return 'ask_user requires at least two options with id and label.';
    }
    if (!ctx.approve) {
      const first = options[0];
      if (!first) {
        return 'ask_user requires at least two options with id and label.';
      }
      return `No interactive user is available. First option would be: ${first.id} (${first.label}). Question: ${question}`;
    }
    const result = await ctx.approve({
      toolName: 'ask_user',
      summary: question,
      risk: 'external',
      options,
      argsPreview: { question, options },
    });
    const picked = options.find((option) => option.id === result.optionId);
    if (!picked) {
      return 'ask_user: the human did not pick a listed option. Do not assume a choice.';
    }
    return `User chose "${picked.label}" (id: ${picked.id}).`;
  },
};
