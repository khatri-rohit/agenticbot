import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type {
  ContextBudget,
  ContextReport,
  LedgerEnvelope,
  MemoryFiles,
  ModeName,
  RunPosture,
  Snapshot,
  ThreadPlan,
} from '@org/agent-models';
import {
  CHARS_PER_TOKEN,
  DEFAULT_CONTEXT_BUDGET,
  envelopeToChatMessage,
  formatThreadPlanForPrompt,
  isThreadPlanEmpty,
} from '@org/agent-models';

import { buildSystemPrompt } from '../prompts/system-prompt';
import type { ToolRegistry } from '../tools/type';
import { estimatePromptTokens } from '../model/estimate-prompt-tokens';

export type MentionedThreadContext = {
  threadId: string;
  title: string;
  sourceLabel: string;
  text: string;
};

export type AssembleContextInput = {
  tools: ToolRegistry;
  memory: MemoryFiles;
  snapshot: Snapshot | null;
  /** Hydrated ledger (blob bodies inlined). Assembler never reads disk. */
  envelopes: LedgerEnvelope[];
  /** Drives home vs workspace system-prompt behavior. */
  mode?: ModeName;
  /** Workspace Ask vs Agent; ignored for Home. Default agent. */
  posture?: RunPosture;
  /**
   * Other threads the user attached to the current turn.
   * Packed by the host; not ledger rows of this thread.
   */
  mentionedThreads?: MentionedThreadContext[];
  /** Thread-scoped plan journal + todos. Injected when non-empty. */
  plan?: ThreadPlan | null;
};

export type AssembleContextResult = {
  messages: ChatCompletionMessageParam[];
  report: ContextReport;
};

function charsToTokens(length: number): number {
  if (length <= 0) return 0;
  return Math.ceil(length / CHARS_PER_TOKEN);
}

function buildMemoryPrompt(memory: MemoryFiles): string {
  const user = memory.user.trim();
  const notes = memory.notes.trim();
  const project = memory.project?.trim() ?? '';
  const agents = memory.agentsMd?.trim() ?? '';

  const parts: string[] = [];
  if (user) {
    parts.push(
      [
        '# User profile (USER.md)',
        'Durable facts. Adapt tone and working style. Do not recite unless asked.',
        'Do not invent a biography beyond this block.',
        '',
        user,
      ].join('\n'),
    );
  } else {
    parts.push(
      [
        '# User profile (USER.md)',
        'Empty. Do not invent a biography, job title, or preferences.',
      ].join('\n'),
    );
  }

  if (notes) {
    const notesTitle =
      memory.agentsMd || memory.project
        ? '# Workspace notes (this folder)'
        : '# Agent notes (MEMORY.md)';
    parts.push([notesTitle, notes].join('\n'));
  }
  if (agents) {
    parts.push(['# Project instructions (AGENTS.md)', agents].join('\n'));
  }
  if (project) {
    parts.push(['# Project notes (PROJECT.md)', project].join('\n'));
  }

  return parts.join('\n\n');
}

function userSeqs(envelopes: LedgerEnvelope[]): number[] {
  return envelopes
    .filter((envelope) => envelope.record.role === 'user')
    .map((envelope) => envelope.seq);
}

function stubToolContent(envelope: LedgerEnvelope): string {
  if (envelope.record.role !== 'tool') return '';
  if (envelope.contentBlob) {
    return `(stub) tool ${envelope.record.tool_call_id} full result in blob sha256:${envelope.contentBlob}`;
  }
  const n = envelope.record.content.length;
  return `(stub) tool ${envelope.record.tool_call_id} omitted (${n} chars)`;
}

/**
 * In-loop sibling of assembleContext stubbing. Mutates live Chat Completions
 * messages so a long tool turn does not keep every result at full size.
 * Ledger rows stay full; the next assembleContext pass stubs from seq.
 */
export function stubLiveToolResults(
  messages: ChatCompletionMessageParam[],
  budget: ContextBudget = DEFAULT_CONTEXT_BUDGET,
): number {
  const maxToolChars = budget.toolResultMaxTokens * CHARS_PER_TOKEN;
  const userIndexes: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === 'user') userIndexes.push(i);
  }
  const keepFromIndex =
    userIndexes.length <= budget.keepToolResultsForTurns
      ? 0
      : (userIndexes[userIndexes.length - budget.keepToolResultsForTurns] ?? 0);

  let stubbed = 0;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message || message.role !== 'tool') continue;
    const content = typeof message.content === 'string' ? message.content : '';
    if (content.startsWith('(stub)')) continue;
    const old = i < keepFromIndex;
    const overCap = content.length > maxToolChars;
    if (!old && !overCap) continue;
    messages[i] = {
      role: 'tool',
      tool_call_id: message.tool_call_id,
      content: `(stub) tool ${message.tool_call_id} omitted (${content.length} chars)`,
    };
    stubbed++;
  }
  return stubbed;
}

function toParam(
  envelope: LedgerEnvelope,
  stub: boolean,
): ChatCompletionMessageParam | null {
  if (stub && envelope.record.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: envelope.record.tool_call_id,
      content: stubToolContent(envelope),
    };
  }
  const chat = envelopeToChatMessage(envelope);
  if (!chat) return null;
  if (chat.role === 'user') {
    return { role: 'user', content: chat.content };
  }
  if (chat.role === 'assistant') {
    return {
      role: 'assistant',
      content: chat.content,
      ...(chat.tool_calls?.length ? { tool_calls: chat.tool_calls } : {}),
    };
  }
  if (chat.role !== 'tool') return null;
  return {
    role: 'tool',
    tool_call_id: chat.tool_call_id,
    content: chat.content,
  };
}

function layerTokens(
  messages: ChatCompletionMessageParam[],
  tools: ToolRegistry['definitions'] = [],
): number {
  return estimatePromptTokens(messages, tools);
}

/**
 * Pure assembler. Same envelopes + memory + snapshot → same messages.
 * Stubbing is free and deterministic; compaction is reported, not performed.
 *
 * Cache contract: the returned messages are ordered stable-first (system,
 * memory, plan, mentions, brief) then volatile (tail, current turn). The
 * loop mutates this array in-place by appending tool results — it never
 * copies or reorders the prefix. Providers with prompt caching (OpenAI
 * automatic prefix cache, Ollama context reuse) can exploit this: the
 * frozen prefix is byte-stable across iterations within a run, so only the
 * growing tail is "new" work. The only per-run variance in the prefix is
 * `today()` in the system prompt, which is stable within a calendar day.
 */
export function assembleContext(
  input: AssembleContextInput,
  budget: ContextBudget = DEFAULT_CONTEXT_BUDGET,
): AssembleContextResult {
  const systemText = buildSystemPrompt(
    input.tools,
    input.mode,
    input.posture ?? 'agent',
  );
  const systemMessage: ChatCompletionMessageParam = {
    role: 'system',
    content: systemText,
  };

  const memoryText = buildMemoryPrompt(input.memory);
  const memoryMessage: ChatCompletionMessageParam = {
    role: 'system',
    content: memoryText,
  };

  const plan = input.plan ?? null;
  const planText =
    plan && !isThreadPlanEmpty(plan) ? formatThreadPlanForPrompt(plan) : '';
  const planMessage: ChatCompletionMessageParam | null = planText
    ? { role: 'system', content: planText }
    : null;

  const afterSeq = input.snapshot?.throughSeq ?? 0;
  const live = input.envelopes.filter((envelope) => envelope.seq > afterSeq);

  const briefParts: string[] = [];
  if (input.snapshot?.brief) {
    briefParts.push(`# Thread brief\n${input.snapshot.brief}`);
  }
  if (input.snapshot?.summary) {
    briefParts.push(`# Earlier turns (compacted)\n${input.snapshot.summary}`);
  }
  const briefMessage: ChatCompletionMessageParam | null = briefParts.length
    ? { role: 'system', content: briefParts.join('\n\n') }
    : null;

  const mentionParts = (input.mentionedThreads ?? [])
    .filter((mention) => mention.text.trim().length > 0)
    .map(
      (mention) =>
        `## ${mention.title}\nSource: ${mention.sourceLabel}\n\n${mention.text.trim()}`,
    );
  const mentionsMessage: ChatCompletionMessageParam | null =
    mentionParts.length > 0
      ? {
          role: 'system',
          content: [
            '# Attached threads',
            'Other conversations the user attached to this turn. Use them as background.',
            'They are not this thread\'s ledger. Do not treat them as files you edited here.',
            '',
            mentionParts.join('\n\n'),
          ].join('\n'),
        }
      : null;

  const users = userSeqs(live);
  const keepFrom =
    users.length <= budget.keepToolResultsForTurns
      ? 0
      : users[users.length - budget.keepToolResultsForTurns];

  const lastUserSeq = users.at(-1);
  const maxToolChars = budget.toolResultMaxTokens * CHARS_PER_TOKEN;

  let stubbedToolResults = 0;
  const tailMessages: ChatCompletionMessageParam[] = [];
  const turnMessages: ChatCompletionMessageParam[] = [];

  for (const envelope of live) {
    const inTurn = lastUserSeq !== undefined && envelope.seq >= lastUserSeq;
    const oldTool =
      envelope.record.role === 'tool' && envelope.seq < keepFrom;
    const overCap =
      envelope.record.role === 'tool' &&
      envelope.record.content.length > maxToolChars;
    const stub = oldTool || overCap;
    if (stub) stubbedToolResults++;

    const message = toParam(envelope, stub);
    if (!message) continue;
    if (inTurn) turnMessages.push(message);
    else tailMessages.push(message);
  }

  const messages: ChatCompletionMessageParam[] = [
    systemMessage,
    memoryMessage,
    ...(planMessage ? [planMessage] : []),
    ...(mentionsMessage ? [mentionsMessage] : []),
    ...(briefMessage ? [briefMessage] : []),
    ...tailMessages,
    ...turnMessages,
  ];

  const layers = [
    {
      id: 'system',
      label: 'System',
      tokens: layerTokens([systemMessage], input.tools.definitions),
    },
    {
      id: 'memory',
      label: 'Memory',
      tokens: charsToTokens(memoryText.length) + 4,
    },
    {
      id: 'plan',
      label: 'Plan',
      tokens: planText ? charsToTokens(planText.length) + 4 : 0,
    },
    {
      id: 'mentions',
      label: 'Attached threads',
      tokens: mentionsMessage
        ? charsToTokens(String(mentionsMessage.content).length) + 4
        : 0,
    },
    {
      id: 'brief',
      label: 'Thread brief',
      tokens: briefMessage
        ? charsToTokens(String(briefMessage.content).length) + 4
        : 0,
    },
    {
      id: 'tail',
      label: 'Recent tail',
      tokens: layerTokens(tailMessages),
    },
    {
      id: 'turn',
      label: 'Current turn',
      tokens: layerTokens(turnMessages),
    },
    {
      id: 'scratch',
      label: 'Run scratch',
      tokens: 0,
    },
  ];

  const occupiedTokens = layers.reduce((sum, layer) => sum + layer.tokens, 0);
  const inputBudget = budget.windowTokens - budget.outputReserveTokens;
  const needsCompaction =
    occupiedTokens > inputBudget * budget.compactAtRatio;

  const report: ContextReport = {
    budget,
    layers,
    occupiedTokens,
    stubbedToolResults,
    needsCompaction,
  };

  return { messages, report };
}
