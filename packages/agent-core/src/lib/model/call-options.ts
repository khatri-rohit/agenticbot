import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources/chat/completions';
import type { OllamaEndpoint } from '@agent/agent-models';

/** Optional knobs closed over by createInvoke/StreamModelCall. */
export type ModelCallOptions = {
  /** Ollama OpenAI-compat thinking control (`"none"` = off). */
  reasoningEffort?: string;
  /** Cancels the in-flight chat.completions request. */
  signal?: AbortSignal;
  /** Cloud vs local Ollama base URL for this call. Default cloud. */
  endpoint?: OllamaEndpoint;
  /** Profile temperature (Home ~0.65, Workspace ~0.2). */
  temperature?: number;
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
