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
} from '@desk/agent-models';
import {
  CHARS_PER_TOKEN,
  DEFAULT_CONTEXT_BUDGET,
  envelopeToChatMessage,
  formatThreadPlanForPrompt,
  imageAttachments,
  isThreadPlanEmpty,
} from '@desk/agent-models';

import { buildSystemPrompt } from '../prompts/system-prompt';
import type { ToolRegistry } from '../tools/type';
import { stubWebSourceCard } from '../tools/web-source';
import { hostListedWebUrls } from '../tools/web-trust';
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
  const card = stubWebSourceCard(
    envelope.record.content,
    envelope.record.tool_call_id,
  );
  if (card) return card;
  const listed = hostListedWebUrls(envelope.record.content);
  const urlTail =
    listed.length > 0
      ? `\n${listed.map((url) => `URL: ${url}`).join('\n')}`
      : '';
  if (envelope.contentBlob) {
    return `(stub) tool ${envelope.record.tool_call_id} full result in blob sha256:${envelope.contentBlob}${urlTail}`;
  }
  const n = envelope.record.content.length;
  return `(stub) tool ${envelope.record.tool_call_id} omitted (${n} chars)${urlTail}`;
}

/**
 * Recent oversized tool rows keep a prefix (and host-listed URLs) so research
 * can continue. Silent "omitted" is only for old turns.
 */
export function capRecentToolContent(
  content: string,
  maxChars: number,
): string {
  if (content.length <= maxChars) return content;
  const listed = hostListedWebUrls(content);
  const listing =
    listed.length > 0
      ? `${listed.map((url) => `URL: ${url}`).join('\n')}\n\n`
      : '';
  const footer = `\n\n(live prompt capped at ${maxChars} chars; full tool result remains in the ledger)`;
  const budget = maxChars - listing.length - footer.length;
  if (budget < 256) {
    return `${content.slice(0, maxChars)}${footer}`;
  }
  return `${listing}${content.slice(0, budget)}${footer}`;
}

/** 0 = keep all (not enough turns yet). Else seq/index of the first kept user turn. */
function keepFromNthLast(markers: number[], keepTurns: number): number {
  if (markers.length <= keepTurns) return 0;
  return markers[markers.length - keepTurns] ?? 0;
}

function stubbedImageNote(imageCount: number): string {
  const noun = imageCount === 1 ? 'attachment' : 'attachments';
  return `(stub) ${imageCount} image ${noun} omitted`;
}

function stubbedUserText(text: string, imageCount: number): string {
  const note = stubbedImageNote(imageCount);
  const trimmed = text.trim();
  return trimmed ? `${trimmed}\n${note}` : note;
}

function imagePartCount(
  content: ChatCompletionMessageParam['content'],
): number {
  if (!Array.isArray(content)) return 0;
  return content.filter((part) => part.type === 'image_url').length;
}

/**
 * In-loop sibling of assembleContext stubbing. Mutates live Chat Completions
 * messages so a long tool turn does not keep every result at full size, and
 * so old vision parts drop the same way as assemble-time attachment stubs.
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
  const keepToolsFrom = keepFromNthLast(
    userIndexes,
    budget.keepToolResultsForTurns,
  );
  const keepImagesFrom = keepFromNthLast(
    userIndexes,
    budget.keepAttachmentsForTurns,
  );

  let stubbed = 0;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === 'user' && i < keepImagesFrom) {
      const n = imagePartCount(message.content);
      if (n === 0) continue;
      const text =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('\n');
      messages[i] = { role: 'user', content: stubbedUserText(text, n) };
      continue;
    }
    if (message.role !== 'tool') continue;
    const content = typeof message.content === 'string' ? message.content : '';
    if (content.startsWith('(stub)')) continue;
    const old = i < keepToolsFrom;
    const overCap = content.length > maxToolChars;
    if (!old && !overCap) continue;
    if (old) {
      const card = stubWebSourceCard(content, message.tool_call_id);
      messages[i] = {
        role: 'tool',
        tool_call_id: message.tool_call_id,
        content:
          card ??
          `(stub) tool ${message.tool_call_id} omitted (${content.length} chars)`,
      };
    } else {
      messages[i] = {
        role: 'tool',
        tool_call_id: message.tool_call_id,
        content: capRecentToolContent(content, maxToolChars),
      };
    }
    stubbed++;
  }
  return stubbed;
}

function toParam(
  envelope: LedgerEnvelope,
  stubTool: boolean,
  stubImages: boolean,
): ChatCompletionMessageParam | null {
  if (stubTool && envelope.record.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: envelope.record.tool_call_id,
      content: stubToolContent(envelope),
    };
  }
  if (stubImages && envelope.record.role === 'user') {
    const n = imageAttachments(envelope.attachments).length;
    if (n > 0) {
      return {
        role: 'user',
        content: stubbedUserText(envelope.record.content, n),
      };
    }
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
  const keepToolsFrom = keepFromNthLast(users, budget.keepToolResultsForTurns);
  const keepImagesFrom = keepFromNthLast(
    users,
    budget.keepAttachmentsForTurns,
  );

  const lastUserSeq = users.at(-1);
  const maxToolChars = budget.toolResultMaxTokens * CHARS_PER_TOKEN;

  let stubbedToolResults = 0;
  const tailMessages: ChatCompletionMessageParam[] = [];
  const turnMessages: ChatCompletionMessageParam[] = [];

  for (const envelope of live) {
    const inTurn = lastUserSeq !== undefined && envelope.seq >= lastUserSeq;
    const oldTool =
      envelope.record.role === 'tool' && envelope.seq < keepToolsFrom;
    const overCap =
      envelope.record.role === 'tool' &&
      envelope.record.content.length > maxToolChars;
    const stubTool = oldTool;
    if (oldTool) stubbedToolResults++;
    const stubImages =
      envelope.record.role === 'user' && envelope.seq < keepImagesFrom;

    let message = toParam(envelope, stubTool, stubImages);
    if (
      message?.role === 'tool' &&
      overCap &&
      !oldTool &&
      typeof message.content === 'string'
    ) {
      message = {
        role: 'tool',
        tool_call_id: message.tool_call_id,
        content: capRecentToolContent(message.content, maxToolChars),
      };
    }
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
