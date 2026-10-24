import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ModeName, RunPosture } from '@agent/agent-models';

import { buildSystemPrompt } from '../prompts/system-prompt';
import { formatSkillsCatalog, selectSkills } from '../tools/skills';
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
  const selected = tools.byName.has('load_skill')
    ? selectSkills({ query: task, mode }).selected
    : [];
  return [
    {
      role: 'system',
      content: buildSystemPrompt(tools, mode, posture),
    },
    ...(selected.length > 0
      ? [{ role: 'system' as const, content: formatSkillsCatalog(selected) }]
      : []),
    {
      role: 'user',
      content: task,
    },
  ];
}
