import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import { buildSystemPrompt } from '../prompts/system-prompt';
import type { ToolRegistry } from '../tools/type';

/**
 * Harness/CLI helper: system prompt + single user task.
 * Chat API builds messages from the client thread and calls buildSystemPrompt separately.
 */
export function getContext(
  task: string,
  tools: ToolRegistry,
  userPersona?: string,
): ChatCompletionMessageParam[] {
  return [
    {
      role: 'system',
      content: buildSystemPrompt(tools, userPersona),
    },
    {
      role: 'user',
      content: task,
    },
  ];
}
