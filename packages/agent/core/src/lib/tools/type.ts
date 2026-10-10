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
 * The result of a web search.
 * This is the data structure returned by the web_search api.
 */
export type WebSearchResult = {
  title: string;
  url: string;
  content: string;
};

export type WebSearchResponse = {
  results: WebSearchResult[];
};

export type WebFetchResponse = {
  title: string;
  url?: string;
  content: string;
  links: string[];
};

export type WebSearchResults = {
  query: string;
  results: WebFetchResponse[];
};

/**
 * Skill metadata for the agent.
 * This is the metadata for a skill that the agent can use.
 */
export interface SkillMetadata {
  name: string;
  description: string;
}

export interface Skill extends SkillMetadata {
  instructions: string;
}
