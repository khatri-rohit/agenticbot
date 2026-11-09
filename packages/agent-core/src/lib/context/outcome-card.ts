import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

/**
 * Outcome cards: what an old tool call did and what came back, in one line.
 * They replace bare "(stub) … omitted" rows so a later turn can still answer
 * "why did that fail?" without the full result. The "(stub)" prefix keeps
 * them recognised as already shrunk by every pass that skips stubs.
 */

export type ToolCallInfo = { name: string; args: string };

const ARGS_PREVIEW_MAX = 160;

/** tool_call_id → name + raw arguments, from assistant rows. */
export function toolCallIndex(
  messages: ChatCompletionMessageParam[],
): Map<string, ToolCallInfo> {
  const byId = new Map<string, ToolCallInfo>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.tool_calls) continue;
    for (const call of message.tool_calls) {
      if (call.type !== 'function') continue;
      byId.set(call.id, {
        name: call.function.name,
        args: call.function.arguments,
      });
    }
  }
  return byId;
}

export function argsPreview(raw: string): string {
  const compact = raw.replace(/\s+/g, ' ').trim();
  return compact.length > ARGS_PREVIEW_MAX
    ? `${compact.slice(0, ARGS_PREVIEW_MAX)}…`
    : compact;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

const FAILED_PREFIX = 'Tool execution failed:';

/**
 * The part of a result worth keeping, by tool family. Terminal errors sit at
 * the end of the output, so a failed command keeps its last lines.
 */
function outcomeOf(name: string, content: string): string {
  if (content.startsWith(FAILED_PREFIX)) {
    return `failed: ${clip(content.slice(FAILED_PREFIX.length), 200)}`;
  }
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const first = lines[0] ?? '(empty result)';
  if (name === 'run_terminal') {
    // `cwd: …`, then `exit <n>` / `signal <name>`, then output.
    const status = lines[1] ?? '';
    if (!/^(exit|signal) /.test(status)) return clip(first, 200);
    const output = lines.slice(2);
    if (output.length === 0) return status;
    return status === 'exit 0'
      ? `${status}; ${clip(output.at(-1) ?? '', 160)}`
      : `${status}; ${clip(output.slice(-3).join(' | '), 240)}`;
  }
  if (name === 'glob' || name === 'grep') {
    return `${lines.length} lines; first: ${clip(first, 140)}`;
  }
  return clip(first, 200);
}

/**
 * One-line card for an old tool result. `blobSha` points at the full body
 * when the host stored it; `tail` carries lines that must survive (URLs).
 */
export function outcomeCard(input: {
  toolCallId: string;
  info: ToolCallInfo | undefined;
  content: string;
  blobSha?: string;
  tail?: string;
}): string {
  const name = input.info?.name ?? 'tool';
  const args = input.info ? ` ${argsPreview(input.info.args)}` : '';
  const recall = input.blobSha
    ? ` · sha256:${input.blobSha} (recall to read it in full)`
    : '';
  return `(stub) ${name}${args} → ${outcomeOf(name, input.content)} · ${input.content.length} chars${recall}${input.tail ?? ''}`;
}
