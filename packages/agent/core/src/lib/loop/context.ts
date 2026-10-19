import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ModeName, RunPosture } from '@org/agent-models';

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
  posture: RunPosture = 'agent',
): ChatCompletionMessageParam[] {
  return [
    {
      role: 'system',
      content: buildSystemPrompt(tools, mode, posture),
    },
    {
      role: 'user',
      content: task,
    },
  ];
}
