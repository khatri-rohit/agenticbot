import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources/chat/completions';

/** Optional knobs closed over by createInvoke/StreamModelCall. */
export type ModelCallOptions = {
  /** Ollama OpenAI-compat thinking control (`"none"` = off). */
  reasoningEffort?: string;
};

/**
 * Ollama accepts reasoning_effort strings beyond OpenAI's ReasoningEffort enum.
 */
export type OllamaChatCompletionCreateParamsNonStreaming = Omit<
  ChatCompletionCreateParamsNonStreaming,
  'reasoning_effort'
> & {
  reasoning_effort?: string;
};

export type OllamaChatCompletionCreateParamsStreaming = Omit<
  ChatCompletionCreateParamsStreaming,
  'reasoning_effort'
> & {
  reasoning_effort?: string;
};
