import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ModeName, RunPosture } from '@agent/agent-models';

import { buildSystemPrompt } from '../prompts/system-prompt';
import {
  formatSkillsCatalog,
  listSkills,
  selectSkills,
} from '../tools/skills';
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
  const hasSkills = tools.byName.has('load_skill');
  const suggested = hasSkills
    ? selectSkills({ query: task, mode }).selected.map((skill) => skill.name)
    : [];
  return [
    {
      role: 'system',
      content: buildSystemPrompt(tools, mode, posture),
    },
    ...(hasSkills
      ? [
          {
            role: 'system' as const,
            content: formatSkillsCatalog(listSkills(), suggested),
          },
        ]
      : []),
    {
      role: 'user',
      content: task,
    },
  ];
}
