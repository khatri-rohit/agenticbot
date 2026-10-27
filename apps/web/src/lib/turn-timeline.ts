import {
  isLimitSkipToolContent,
  type Message,
  type PendingToolCall,
} from '@agent/agent-models';

import type {
  AssistantSnippet,
  CompactionNotice,
  ToolActivity,
} from '../features/agent/store/chat-store';

export type ToolCallRow = {
  toolCallId: string;
  toolName: string;
  args?: string;
  result?: string;
  status: 'running' | 'done' | 'failed' | 'skipped';
  durationMs?: number;
};

export type TimelineStep =
  | { type: 'assistant'; message: Message }
  | { type: 'snippet'; messageId: string; content: string }
  | { type: 'tools'; key: string; rows: ToolCallRow[] }
  | { type: 'compaction'; notice: CompactionNotice }
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
  // Settled ledger with no tool row = interrupted (pre-I1 / crash), not in-flight.
  let status: ToolCallRow['status'] = 'failed';
  if (activity) {
    status = activity.status;
  } else if (toolMessage) {
    if (toolMessage.status === 'interrupted') {
      status = 'failed';
    } else if (
      typeof toolMessage.content === 'string' &&
      isLimitSkipToolContent(toolMessage.content)
    ) {
      status = 'skipped';
    } else {
      status = 'done';
    }
  }

  const liveArgs = previewToArgs(activity?.argsPreview);
  const liveResult = previewToArgs(activity?.resultPreview);

  return {
    toolCallId: call.id,
    toolName: call.function.name,
    args: call.function.arguments || liveArgs,
    result:
      toolMessage?.content ??
      liveResult ??
      (status === 'failed' ? 'Skipped: interrupted before result.' : undefined),
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
 * Ordered turn steps: assistant → tools → assistant → live tools → stream →
 * compaction (host post-loop step, same visual column as tools).
 *
 * Mid-run, the ledger is stale until `run.settled`, so `replies` holds only
 * messages from prior runs. Settled assistant messages from the active run
 * arrive as `snippets` (from `assistant.completed`), and in-flight tools
 * arrive as `liveActivity`. We merge snippets and not-yet-ledgered live tools
 * by event `seq` to reconstruct the true interleaved order, then append the
 * active stream and compaction.
 *
 * Ledger dedup: assistant rows in `replies` whose `runId` matches the active
 * run are skipped in the walk — snippets are the sole renderer of active-run
 * prose during the run, so a mid-run ledger refetch (context.compacted bumps
 * the epoch) cannot double-render. At `run.settled` the active run is nulled
 * and the ledger takes over as the only source.
 */
export function buildTurnTimeline(input: {
  replies: Message[];
  liveActivity: ToolActivity[];
  snippets?: AssistantSnippet[];
  activeRunId?: string;
  streaming?: { id: string; content: string } | null;
  compaction?: CompactionNotice | null;
}): TimelineStep[] {
  const steps: TimelineStep[] = [];
  const activityMap = liveById(input.liveActivity);
  const seenToolIds = new Set<string>();
  const replies = input.replies;
  let index = 0;
  let toolsStepIndex = 0;
  const snippets = input.snippets ?? [];

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

    // Skip assistant rows the ledger already has for the active run; they are
    // represented by snippets below, merged in seq order with live tools.
    if (input.activeRunId && message.runId === input.activeRunId) {
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
        return rowFromCall(
          call,
          results.get(call.id),
          activityMap.get(call.id),
        );
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

  // Merge settled snippets and not-yet-ledgered live tools by event seq, so
  // mid-run the timeline reads assistant → tools → assistant → tools in the
  // order events actually arrived.
  type PendingItem =
    | { kind: 'snippet'; seq: number; snippet: AssistantSnippet }
    | { kind: 'tool'; seq: number; activity: ToolActivity };
  const pending: PendingItem[] = [];

  for (const snippet of snippets) {
    pending.push({ kind: 'snippet', seq: snippet.seq, snippet });
  }

  const liveOnly = input.liveActivity.filter(
    (activity) => !seenToolIds.has(activity.toolCallId),
  );
  for (const activity of liveOnly) {
    pending.push({ kind: 'tool', seq: activity.seq, activity });
  }

  pending.sort((a, b) => a.seq - b.seq);

  // Render in seq order, merging adjacent tool items into one tools step —
  // matching how the ledger groups a tool_calls row with its tool results.
  let pendingTools: ToolActivity[] = [];
  const flushTools = () => {
    if (pendingTools.length === 0) return;
    steps.push({
      type: 'tools',
      key: `tools-live-${toolsStepIndex++}`,
      rows: pendingTools.map(rowFromLive),
    });
    pendingTools = [];
  };
  for (const item of pending) {
    if (item.kind === 'snippet') {
      flushTools();
      if (item.snippet.content.trim()) {
        steps.push({
          type: 'snippet',
          messageId: item.snippet.messageId,
          content: item.snippet.content,
        });
      }
    } else {
      pendingTools.push(item.activity);
    }
  }
  flushTools();

  const streamContent = input.streaming?.content.trim();
  if (streamContent) {
    steps.push({ type: 'stream', content: streamContent });
  }

  if (input.compaction) {
    steps.push({ type: 'compaction', notice: input.compaction });
  }

  return steps;
}
