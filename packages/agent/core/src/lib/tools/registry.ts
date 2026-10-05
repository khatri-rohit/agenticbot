import type {
  ChatCompletionTool,
  ChatCompletionFunctionTool,
} from 'openai/resources/chat/completions';

/**
 * Guidance text injected into the system prompt per tool.
 * This is policy, not schema — kept separate from the OpenAI tool definition.
 */
export type ToolGuidance = {
  whenToUse: string[];
  whenNotToUse: string[];
  usage: string[];
};

export type Tool = {
  definition: ChatCompletionFunctionTool;
  guidance: ToolGuidance;
  execute: (args: Record<string, unknown>) => Promise<string>;
};

export type ToolRegistry = {
  definitions: ChatCompletionTool[];
  byName: Map<string, Tool>;
};

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