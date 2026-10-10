import { load_skill } from './skills';
import type { Tool, ToolRegistry } from './type';
import { WEB_SEARCH_TOOLS } from './web-search';

/**
 * Build a ToolRegistry from a list of tools.
 * Filters tools by an optional allow-list (used by ModeConfig.allowedTools).
 */
export function createToolRegistry(
  tools: Tool[],
  allowedTools?: string[],
): ToolRegistry {
  const filtered = allowedTools
    ? tools.filter((t) => allowedTools.includes(t.definition.function.name))
    : tools;

  return {
    definitions: filtered.map((t) => t.definition),
    byName: new Map(filtered.map((t) => [t.definition.function.name, t])),
  };
}

export const ALL_TOOLS: Tool[] = [load_skill, ...WEB_SEARCH_TOOLS];
