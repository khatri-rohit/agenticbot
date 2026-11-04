import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import type { EffortSignals } from './effort';

const TASK_MAX = 600;
const STEP_MAX = 300;

function textOf(message: ChatCompletionMessageParam | undefined): string {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => ('text' in part && typeof part.text === 'string' ? part.text : '')).join('\n');
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Compact state for an effort decision, built only from loop data. Tool
 * results go in as names and flags, never bodies: a fetched page cannot put
 * text in front of the scorer.
 */
export function buildEffortState(input: {
  messages: ChatCompletionMessageParam[];
  /** Index of the first message this run appended. */
  runStart: number;
  signals: EffortSignals;
  maxIterations?: number;
  mode: string;
}): string {
  const { messages, runStart, signals } = input;

  let task = '';
  for (let i = Math.min(runStart, messages.length) - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      task = textOf(messages[i]);
      break;
    }
  }

  let lastAssistant: ChatCompletionMessageParam | undefined;
  for (let i = messages.length - 1; i >= runStart; i--) {
    if (messages[i]?.role === 'assistant') {
      lastAssistant = messages[i];
      break;
    }
  }
  const toolNames =
    lastAssistant && 'tool_calls' in lastAssistant && lastAssistant.tool_calls
      ? lastAssistant.tool_calls.map((call) => ('function' in call ? call.function.name : 'tool'))
      : [];

  const lines = [
    `Task: ${clip(task, TASK_MAX) || '(none)'}`,
    `Iteration: ${signals.iteration}${input.maxIterations ? ` of up to ${input.maxIterations}` : ''}. Mode: ${input.mode}.`,
    `Last assistant step: ${clip(textOf(lastAssistant), STEP_MAX) || '(tool calls only)'}`,
    `Last tools: ${toolNames.length ? toolNames.join(', ') : 'none'}`,
    `Signals: ${signals.toolError ? 'a tool failed' : 'no tool errors'}; ${signals.wrote ? 'files edited or commands run' : 'no edits or commands'}; ${signals.steering ? 'new instruction to act on' : 'no new instruction'}.`,
  ];
  return lines.join('\n');
}
