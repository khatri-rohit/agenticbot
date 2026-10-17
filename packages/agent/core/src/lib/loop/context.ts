import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import { buildSystemPrompt } from '../prompts/system-prompt';
import type { ToolRegistry } from '../tools/type';

/**
 * Harness/CLI helper: system prompt + single user task.
 * Chat API builds messages with assembleContext (system + memory + ledger).
 */
export function getContext(
  task: string,
  tools: ToolRegistry,
): ChatCompletionMessageParam[] {
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
}
