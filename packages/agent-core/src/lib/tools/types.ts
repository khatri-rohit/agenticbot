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

/**
 * Loop scheduling class. skill/read/subagent batches run in parallel;
 * network/exec/mutate run one at a time. A tool without a stage (e.g. a
 * future MCP tool) is scheduled as `mutate`, the strictest class.
 */
export type ToolStage = 'skill' | 'read' | 'network' | 'subagent' | 'exec' | 'mutate';

export type Tool = {
  definition: ChatCompletionFunctionTool;
  guidance: ToolGuidance;
  /** Host approval / cron profiles key off this (default treated as read). */
  risk?: ToolRisk;
  stage?: ToolStage;
  /** Hard cap on result chars before the result joins the prompt. */
  outputCap?: number;
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
