import {
  ChoiceSkipped,
  MAX_CHOICE_OPTIONS,
  type ChoiceOption,
} from '@desk/agent-models';

import type { Tool } from './type';

function parseOptions(raw: unknown): ChoiceOption[] {
  if (!Array.isArray(raw)) return [];
  const options: ChoiceOption[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const label = typeof record.label === 'string' ? record.label.trim() : '';
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    options.push({ id, label });
    if (options.length >= MAX_CHOICE_OPTIONS) break;
  }
  return options;
}

function formatContinue(optionIds: string[], options: ChoiceOption[], text?: string): string {
  const chosen = optionIds
    .map((id) => options.find((option) => option.id === id))
    .filter((option): option is ChoiceOption => Boolean(option));
  const lines: string[] = [];
  if (chosen.length > 0) {
    lines.push('User chose:');
    for (const option of chosen) {
      lines.push(`- ${option.label} (id: ${option.id})`);
    }
  }
  const extra = text?.trim();
  if (extra) {
    lines.push(chosen.length > 0 ? `Also directed: ${extra}` : `User directed: ${extra}`);
  }
  return lines.join('\n');
}

/**
 * Mid-turn direction: any subset of options plus optional extra text.
 * Skip stops the run; it does not pick a default path.
 */
export const offer_choice: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'offer_choice',
      description:
        'Pause for the human to steer. Show two or more options as checkboxes (they may pick several) plus an extra text field. Use when approaches or attributes would change the work. Do not use to ask permission to edit or run commands.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The question to show above the options.',
          },
          options: {
            type: 'array',
            minItems: 2,
            maxItems: MAX_CHOICE_OPTIONS,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Stable option id.' },
                label: {
                  type: 'string',
                  description: 'Short checkbox label.',
                },
              },
              required: ['id', 'label'],
              additionalProperties: false,
            },
            description: 'At least two options. The human may check any subset.',
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
      'Two or more viable next actions would produce different work, or you need a checklist of attributes (style, scope, trade-offs).',
    ],
    whenNotToUse: [
      'Do not use this to ask permission to edit files or run commands — those tools run without a pause.',
      'Do not use this for trivia, or when one next step is already obvious.',
    ],
    usage: [
      'Pass a short question and at least two options with stable ids.',
      'The human may check several options and/or type extra direction. Follow all of that.',
      'If they skip, stop. Do not invent a path.',
    ],
  },
  execute: async (args, ctx) => {
    const question = String(args.question ?? '').trim();
    const options = parseOptions(args.options);
    if (!question) {
      return 'offer_choice requires a non-empty question.';
    }
    if (options.length < 2) {
      return 'offer_choice requires at least two options with unique id and label.';
    }
    if (!ctx.offerChoice) {
      return `No interactive user is available. Question: ${question}`;
    }
    const result = await ctx.offerChoice({ question, options });
    const optionIds = result.optionIds.filter((id) =>
      options.some((option) => option.id === id),
    );
    const text = result.text?.trim();
    if (optionIds.length === 0 && !text) {
      throw new ChoiceSkipped();
    }
    return formatContinue(optionIds, options, text);
  },
};
