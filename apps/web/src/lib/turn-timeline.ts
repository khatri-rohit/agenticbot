import type { Message, PendingToolCall } from '@org/agent-models';

import type { ToolActivity } from '../features/agent/store/chat-store';

export type ToolCallRow = {
  toolCallId: string;
  toolName: string;
  args?: string;
  result?: string;
  status: 'running' | 'done' | 'failed';
  durationMs?: number;
};

export type TimelineStep =
  | { type: 'assistant'; message: Message }
  | { type: 'tools'; key: string; rows: ToolCallRow[] }
  | { type: 'stream'; content: string };

function previewToArgs(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function liveById(liveActivity: ToolActivity[]): Map<string, ToolActivity> {
  const map = new Map<string, ToolActivity>();
  for (const activity of liveActivity) {
    map.set(activity.toolCallId, activity);
  }
  return map;
}

function rowFromCall(
  call: PendingToolCall,
  toolMessage: Message | undefined,
  activity: ToolActivity | undefined,
): ToolCallRow {
  let status: ToolCallRow['status'] = 'running';
  if (activity) {
    status = activity.status;
  } else if (toolMessage) {
    status = toolMessage.status === 'interrupted' ? 'failed' : 'done';
  }

  const liveArgs = previewToArgs(activity?.argsPreview);
  const liveResult = previewToArgs(activity?.resultPreview);

  return {
    toolCallId: call.id,
    toolName: call.function.name,
    args: call.function.arguments || liveArgs,
    result: toolMessage?.content ?? liveResult,
    status,
    durationMs: activity?.durationMs,
  };
}

function rowFromLive(activity: ToolActivity): ToolCallRow {
  return {
    toolCallId: activity.toolCallId,
    toolName: activity.toolName,
    args: previewToArgs(activity.argsPreview),
    result: previewToArgs(activity.resultPreview),
    status: activity.status,
    durationMs: activity.durationMs,
  };
}

/**
 * Ordered turn steps for the chat UI: assistant prose, then that assistant's
 * tools, then the next assistant, then live-only tools, then streaming text.
 * Ledger is the durable tape; liveActivity overlays status before hydrate.
 */
export function buildTurnTimeline(input: {
  replies: Message[];
  liveActivity: ToolActivity[];
  streaming?: { id: string; content: string } | null;
}): TimelineStep[] {
  const steps: TimelineStep[] = [];
  const activityMap = liveById(input.liveActivity);
  const seenToolIds = new Set<string>();
  const replies = input.replies;
  let index = 0;
  let toolsStepIndex = 0;

  while (index < replies.length) {
    const message = replies[index];

    if (message.role === 'tool') {
      index += 1;
      continue;
    }

    if (message.role !== 'assistant') {
      index += 1;
      continue;
    }

    if (message.content.trim()) {
      steps.push({ type: 'assistant', message });
    }

    const calls = message.toolCalls ?? [];
    if (calls.length > 0) {
      const results = new Map<string, Message>();
      let cursor = index + 1;
      while (cursor < replies.length && replies[cursor].role === 'tool') {
        const toolMessage = replies[cursor];
        if (toolMessage.toolCallId) {
          results.set(toolMessage.toolCallId, toolMessage);
        }
        cursor += 1;
      }

      const rows = calls.map((call) => {
        seenToolIds.add(call.id);
        return rowFromCall(call, results.get(call.id), activityMap.get(call.id));
      });
      steps.push({
        type: 'tools',
        key: `tools-${message.id}-${toolsStepIndex++}`,
        rows,
      });
      index = cursor;
      continue;
    }

    index += 1;
  }

  const liveOnly = input.liveActivity.filter(
    (activity) => !seenToolIds.has(activity.toolCallId),
  );
  if (liveOnly.length > 0) {
    steps.push({
      type: 'tools',
      key: `tools-live-${toolsStepIndex}`,
      rows: liveOnly.map(rowFromLive),
    });
  }

  const streamContent = input.streaming?.content?.trim();
  if (streamContent) {
    steps.push({ type: 'stream', content: input.streaming!.content });
  }

  return steps;
}
