/** Optional knobs closed over by createInvoke/StreamModelCall. */
export type ModelCallOptions = {
  /** Ollama OpenAI-compat thinking control (`"none"` = off). */
  reasoningEffort?: string;
};
