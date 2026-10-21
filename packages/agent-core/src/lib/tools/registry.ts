import type { RunPosture } from '@desk/agent-models';
import { applyPostureToTools } from '@desk/agent-models';

import { ask_user } from './ask-user';
import { offer_choice } from './offer-choice';
import { load_skill } from './skills';
import type { Tool, ToolRegistry } from './type';
import { WEB_SEARCH_TOOLS } from './web-search';
import { WORKSPACE_TOOLS } from './workspace';

/**
 * Build a ToolRegistry from a list of tools.
 * Name allow-list is mode/webSearch. Ask posture strips workspace write/exec
 * even if those names were still on the list.
 */
export function createToolRegistry(
  tools: Tool[],
  allowedTools?: string[],
  posture: RunPosture = 'agent',
): ToolRegistry {
  const named = allowedTools
    ? tools.filter((t) => allowedTools.includes(t.definition.function.name))
    : tools;
  const keep = new Set(
    applyPostureToTools(
      named.map((tool) => tool.definition.function.name),
      posture,
    ),
  );
  const filtered = named.filter((tool) =>
    keep.has(tool.definition.function.name),
  );

  return {
    definitions: filtered.map((t) => t.definition),
    byName: new Map(filtered.map((t) => [t.definition.function.name, t])),
  };
}

export const ALL_TOOLS: Tool[] = [
  load_skill,
  ask_user,
  offer_choice,
  ...WEB_SEARCH_TOOLS,
  ...WORKSPACE_TOOLS,
];
