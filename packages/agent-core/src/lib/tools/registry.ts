import type { RunPosture } from '@agent/agent-models';
import { applyPostureToTools } from '@agent/agent-models';

import { offer_choice } from './offer-choice';
import { createDelegateTool } from '../subagent/delegate';
import { listSubagentProfiles } from '../subagent/profiles';
import { recall } from './recall';
import { load_skill } from './skills';
import type { Tool, ToolRegistry } from './type';
import { WEB_SEARCH_TOOLS } from './web-search';
import { WORKSPACE_TOOLS } from './workspace';

/**
 * A source of tools. Built-ins and the sub-agent catalog are providers today;
 * an MCP server or plugin registers one later. Policy (mode allow-lists,
 * posture, sub-agent capability intersection) filters the merged list — no
 * provider bypasses createToolRegistry.
 */
export type ToolProvider = {
  id: string;
  tools: () => Tool[];
};

const providers = new Map<string, ToolProvider>([
  [
    'builtin',
    {
      id: 'builtin',
      tools: () => [load_skill, offer_choice, recall, ...WEB_SEARCH_TOOLS, ...WORKSPACE_TOOLS],
    },
  ],
  [
    'subagents',
    // Rebuilt per call so user agents loaded after startup show in the schema.
    { id: 'subagents', tools: () => [createDelegateTool(listSubagentProfiles())] },
  ],
]);

/** Add or replace a provider. First provider to claim a tool name wins. */
export function registerToolProvider(provider: ToolProvider): void {
  providers.set(provider.id, provider);
}

/** Every tool from every provider, de-duplicated by name. */
export function listTools(): Tool[] {
  const byName = new Map<string, Tool>();
  for (const provider of providers.values()) {
    for (const tool of provider.tools()) {
      const name = tool.definition.function.name;
      if (!byName.has(name)) byName.set(name, tool);
    }
  }
  return [...byName.values()];
}

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
