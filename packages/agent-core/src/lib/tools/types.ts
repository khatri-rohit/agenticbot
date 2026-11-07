import type {
  ChatCompletionTool,
  ChatCompletionFunctionTool,
} from 'openai/resources/chat/completions';

import type { ToolContext, ToolRisk, ToolStage } from '@agent/agent-models';

/**
 * Guidance text injected into the system prompt per tool.
 * This is policy, not schema — kept separate from the OpenAI tool definition.
 */
export type ToolGuidance = {
  whenToUse: string[];
  whenNotToUse: string[];
  usage: string[];
};

/** What a tool's own result says happened, for the trace (see `Tool.classify`). */
export type ToolResultClass = {
  /** `error`: the tool ran but did not do what was asked (edit not applied, command blocked or killed). */
  outcome: 'ok' | 'error';
  /** run_terminal: the command's exit code. Non-zero is still `ok`: a failing test is often the point. */
  exitCode?: number;
};

export type Tool = {
  definition: ChatCompletionFunctionTool;
  guidance: ToolGuidance;
  /** Host approval / cron profiles key off this (default treated as read). */
  risk?: ToolRisk;
  stage?: ToolStage;
  /** Hard cap on result chars before the result joins the prompt. */
  outputCap?: number;
  /** Runs its own timeout (and process-tree kill); the loop's would race it. */
  ownsTimeout?: boolean;
  /** Web research: closes while the run's research gate is shut. */
  research?: boolean;
  /**
   * A gate that ships with the tool: the refusal text when this call must not
   * run, checked once the arguments parse. Refusals do not count toward
   * maxToolCalls.
   */
  admit?: (args: Record<string, unknown>, ctx: ToolContext) => string | null;
  /**
   * Reads the tool's own (shaped) result: did it do what was asked? Only
   * tools whose results carry a failure the trace cannot see otherwise.
   */
  classify?: (result: string) => ToolResultClass;
  /** What the UI shows of the arguments, when the raw arguments are too long or noisy. */
  previewArgs?: (args: Record<string, unknown>) => unknown;
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
