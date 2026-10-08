import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import { buildSystemPrompt } from '../prompts/system-prompt';
import type { ToolRegistry } from '../tools';

export const getContext = (
  task: string,
  tools: ToolRegistry,
): ChatCompletionMessageParam[] => {
  return [
    {
      role: 'system',
      content: buildSystemPrompt(tools),
    },
    {
      role: 'user',
      content: task,
    },
  ];
};
