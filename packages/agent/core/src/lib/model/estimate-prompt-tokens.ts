import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';

/** Rough stand-in when the real vision tokenizer is unknown. */
const ESTIMATED_TOKENS_PER_IMAGE = 1000;
const CHARS_PER_TOKEN = 4;
const ROLE_OVERHEAD = 4;
const TOOLS_BLOCK_OVERHEAD = 4;

function charsToTokens(length: number): number {
  if (length <= 0) return 0;
  return Math.ceil(length / CHARS_PER_TOKEN);
}

function estimateContent(
  content: ChatCompletionMessageParam['content'],
): number {
  if (content == null) return 0;
  if (typeof content === 'string') {
    return charsToTokens(content.length);
  }
  if (!Array.isArray(content)) {
    return charsToTokens(JSON.stringify(content).length);
  }

  let tokens = 0;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if ('type' in part && part.type === 'text' && 'text' in part) {
      tokens += charsToTokens(String(part.text ?? '').length);
      continue;
    }
    if ('type' in part && part.type === 'image_url') {
      tokens += ESTIMATED_TOKENS_PER_IMAGE;
      continue;
    }
    tokens += charsToTokens(JSON.stringify(part).length);
  }
  return tokens;
}

/**
 * Heuristic size of a chat-completions request envelope:
 * system + history + tool schemas. Not a real tokenizer.
 */
export function estimatePromptTokens(
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[] = [],
): number {
  let tokens = 0;

  for (const message of messages) {
    tokens += ROLE_OVERHEAD;
    tokens += estimateContent(message.content);

    if ('tool_calls' in message && message.tool_calls) {
      tokens += charsToTokens(JSON.stringify(message.tool_calls).length);
    }
    if ('tool_call_id' in message && message.tool_call_id) {
      tokens += charsToTokens(String(message.tool_call_id).length);
    }
  }

  if (tools.length > 0) {
    tokens += TOOLS_BLOCK_OVERHEAD;
    tokens += charsToTokens(JSON.stringify(tools).length);
  }

  return tokens;
}
