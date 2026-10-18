import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ModeName } from '@org/agent-models';

import { buildSystemPrompt } from '../prompts/system-prompt';
import type { ToolRegistry } from '../tools/type';

/**
 * Harness/CLI helper: system prompt + single user task.
 * Chat API builds messages with assembleContext (system + memory + ledger).
 */
export function getContext(
  task: string,
  tools: ToolRegistry,
  mode?: ModeName,
): ChatCompletionMessageParam[] {
  return [
    {
      role: 'system',
      content: buildSystemPrompt(tools, mode),
    },
    {
      role: 'user',
      content: task,
    },
  ];
}
