import type {
  ChatCompletionTool,
  ChatCompletionFunctionTool,
} from 'openai/resources/chat/completions';

import type { ToolContext, ToolRisk } from '@agent/agent-models';

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
  /** Host approval / cron profiles key off this (default treated as read). */
  risk?: ToolRisk;
  execute: (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<string>;
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
  /** Retrieval hints from SKILL.md frontmatter. */
  when?: string[];
  not?: string[];
  modes?: string[];
}

export interface Skill extends SkillMetadata {
  instructions: string;
}
