import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import type {
  ContextBudget,
  ContextReport,
  LedgerEnvelope,
  MemoryFiles,
  ModeName,
  RunPosture,
  Snapshot,
  ThreadLastRun,
  ThreadPlan,
} from '@agent/agent-models';
import {
  CHARS_PER_TOKEN,
  DEFAULT_CONTEXT_BUDGET,
  envelopeToChatMessage,
  formatThreadPlanForPrompt,
  imageAttachments,
  isThreadPlanEmpty,
} from '@agent/agent-models';

import { buildSystemPrompt } from '../prompts/system-prompt';
import {
  formatPinnedSkills,
  formatSkillsCatalog,
  listSkills,
  skillCard,
} from '../tools/skills';
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
  /**
   * User-requested skill names for this send (`/` picks).
   * Bodies go into Loaded skills. Catalog is always the full list.
   */
  skillNames?: string[];
  /** Prior run summary for resume; incomplete/cancelled inject a system note. */
  lastRun?: ThreadLastRun | null;
};

/** Prompt-only fill for ledger orphans (pre-I1 / crash). Does not rewrite disk. */
const INTERRUPTED_TOOL_RESULT = 'Skipped: interrupted before result.';

function fillOrphanToolResults(
  messages: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[] {
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool' && typeof message.tool_call_id === 'string') {
      answered.add(message.tool_call_id);
    }
  }
  const out: ChatCompletionMessageParam[] = [];
  for (const message of messages) {
    out.push(message);
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue;
    for (const call of message.tool_calls) {
      if (answered.has(call.id)) continue;
      out.push({
        role: 'tool',
        tool_call_id: call.id,
        content: INTERRUPTED_TOOL_RESULT,
      });
      answered.add(call.id);
    }
  }
  return out;
}

function formatLastRunPrompt(lastRun: ThreadLastRun): string | null {
  if (!lastRun.incomplete && lastRun.status === 'completed') return null;
  const reason =
    lastRun.limitReason ??
    (lastRun.status === 'error'
      ? 'Run ended with an error'
      : 'Run stopped early');
  // Budget, wall-clock, iteration, tool and capacity stops leave a handoff
  // (or the plan) to continue from; re-exploring would re-spend the budget.
  const resumable = /^limit\.(tokens|wall|iterations|tools|capacity)\b/.test(reason);
  return [
    '# Last run',
    `The previous run on this thread ended early (status: ${lastRun.status}).`,
    `Reason: ${reason}`,
    ...(resumable
      ? [
          'If the user asks to continue: pick up from the last assistant message (the handoff) and the plan. Do not redo finished steps or repeat research already done.',
        ]
      : []),
    'Workspace files may have changed since any tool results below. Re-read before editing or relying on those results.',
  ].join('\n');
}

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
  return parts.join('\n\n');
}

function buildRulesPrompt(memory: MemoryFiles): string {
  const parts: string[] = [];
  const agents = memory.agentsMd?.trim() ?? '';
  const project = memory.project?.trim() ?? '';
  if (agents) {
    parts.push(['# Project instructions (AGENTS.md)', agents].join('\n'));
  }
  if (project) {
    parts.push(['# Project notes (PROJECT.md)', project].join('\n'));
  }
  return parts.join('\n\n');
}

function loadSkillNameFromArgs(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const name = (parsed as { skill_name?: unknown }).skill_name;
    return typeof name === 'string' && name.trim() ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

function loadedSkillNamesFromEnvelopes(envelopes: LedgerEnvelope[]): string[] {
  const names: string[] = [];
  for (const envelope of envelopes) {
    if (envelope.record.role !== 'assistant' || !envelope.record.tool_calls) {
      continue;
    }
    for (const call of envelope.record.tool_calls) {
      if (!('function' in call) || call.function.name !== 'load_skill')
        continue;
      const name = loadSkillNameFromArgs(call.function.arguments);
      if (name) names.push(name);
    }
  }
  return names;
}

function toolCallsFromMessage(
  item: LedgerEnvelope | ChatCompletionMessageParam,
): ChatCompletionMessageToolCall[] | undefined {
  if ('record' in item) {
    return item.record.role === 'assistant' ? item.record.tool_calls : undefined;
  }
  return item.role === 'assistant' ? item.tool_calls : undefined;
}

function loadSkillCallIds(
  source: LedgerEnvelope[] | ChatCompletionMessageParam[],
): Set<string> {
  const ids = new Set<string>();
  for (const item of source) {
    const calls = toolCallsFromMessage(item);
    if (!calls) continue;
    for (const call of calls) {
      const name = 'function' in call ? call.function.name : undefined;
      if (name === 'load_skill') ids.add(call.id);
    }
  }
  return ids;
}

function loadSkillTokensFromMessages(
  messages: ChatCompletionMessageParam[],
): number {
  const ids = loadSkillCallIds(messages);
  if (ids.size === 0) return 0;
  let chars = 0;
  for (const message of messages) {
    if (message.role !== 'tool' || !ids.has(message.tool_call_id)) continue;
    chars += String(message.content ?? '').length;
  }
  return charsToTokens(chars);
}

const PREFIX_LAYER_IDS = new Set([
  'system',
  'tools',
  'skills_catalog',
  'skills_bodies',
  'memory',
  'rules',
  'plan',
  'mentions',
  'brief',
  'last_run',
]);

/**
 * Rebuild conversation / loaded-skill layers after a model turn.
 * Prefix layer sizes stay the assemble-time estimates; occupied follows
 * provider promptTokens when present.
 */
export function refreshContextReport(
  report: ContextReport,
  messages: ChatCompletionMessageParam[],
  tools: ToolRegistry,
  usage?: { promptTokens: number },
): ContextReport {
  const prefix = report.layers.filter((layer) =>
    PREFIX_LAYER_IDS.has(layer.id),
  );
  const prefixSum = prefix.reduce((sum, layer) => sum + layer.tokens, 0);
  const skillsLoaded = loadSkillTokensFromMessages(messages);
  const occupied =
    usage?.promptTokens ?? layerTokens(messages, tools.definitions);
  const conversation = Math.max(0, occupied - prefixSum - skillsLoaded);
  const layers = [
    ...prefix,
    { id: 'conversation', label: 'Conversation', tokens: conversation },
    { id: 'skills_loaded', label: 'Loaded skills', tokens: skillsLoaded },
  ];
  const inputBudget =
    report.budget.windowTokens - report.budget.outputReserveTokens;
  return {
    ...report,
    layers,
    occupiedTokens: occupied,
    needsCompaction: occupied > inputBudget * report.budget.compactAtRatio,
  };
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
  /**
   * Index of the first message the running loop appended. Turns are counted
   * only before it: the loop's own nudges are `role: 'user'` but are not user
   * turns, and current-run results shrink only through eviction (which keeps
   * a sha). Omitted at assemble time, where every message is from the ledger.
   */
  liveFrom: number = messages.length,
): number {
  const maxToolChars = budget.toolResultMaxTokens * CHARS_PER_TOKEN;
  const userIndexes: number[] = [];
  for (let i = 0; i < Math.min(liveFrom, messages.length); i++) {
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
              .map((part) => part.text ?? '')
              .join('\n');
      messages[i] = { role: 'user', content: stubbedUserText(text, n) };
      continue;
    }
    if (message.role !== 'tool') continue;
    const content = typeof message.content === 'string' ? message.content : '';
    // Already a stub or a residency card (which carries the sha to recall).
    if (/^\((stub|evicted|skill card|unchanged)/.test(content)) continue;
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
 * The ContextReport here is the measured “used” meter source after turns —
 * not a keystroke-hot estimate path (web must not spam assemble on typing).
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

  const hasLoadSkill = input.tools.byName.has('load_skill');
  const requestedNames = input.skillNames ?? [];
  const skillsText = hasLoadSkill ? formatSkillsCatalog(listSkills()) : '';
  const skillsMessage: ChatCompletionMessageParam | null = skillsText
    ? { role: 'system', content: skillsText }
    : null;
  // bodiesText is computed after keepToolsFrom (below) so loaded-skill names
  // come only from live, unstubbed tool results — not the whole ledger.

  const memoryText = buildMemoryPrompt(input.memory);
  const memoryMessage: ChatCompletionMessageParam = {
    role: 'system',
    content: memoryText,
  };

  const rulesText = buildRulesPrompt(input.memory);
  const rulesMessage: ChatCompletionMessageParam | null = rulesText
    ? { role: 'system', content: rulesText }
    : null;

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
            "They are not this thread's ledger. Do not treat them as files you edited here.",
            '',
            mentionParts.join('\n\n'),
          ].join('\n'),
        }
      : null;

  const lastRunText = input.lastRun ? formatLastRunPrompt(input.lastRun) : null;
  const lastRunMessage: ChatCompletionMessageParam | null = lastRunText
    ? { role: 'system', content: lastRunText }
    : null;

  const users = userSeqs(live);
  const keepToolsFrom = keepFromNthLast(users, budget.keepToolResultsForTurns);
  const keepImagesFrom = keepFromNthLast(users, budget.keepAttachmentsForTurns);

  // Count a skill as loaded only when its load_skill call is in live and its
  // result is not stubbed; otherwise an explicit /skill pick after compaction
  // sends no body and no body is in the prompt.
  // `/` picks are pinned for this send, capped in total; over the cap the
  // largest picks pin core + contents (reported as trimmed to the host).
  const pinned = hasLoadSkill
    ? formatPinnedSkills(
        requestedNames,
        // Only current-turn loads count: earlier turns' skill rows are sent
        // as skill cards (core rules), so a pick must re-pin the full body.
        loadedSkillNamesFromEnvelopes(
          live.filter((envelope) => envelope.seq >= (users.at(-1) ?? Infinity)),
        ),
      )
    : { text: '', trimmed: [] };
  const bodiesText = pinned.text;
  const bodiesMessage: ChatCompletionMessageParam | null = bodiesText
    ? { role: 'system', content: bodiesText }
    : null;

  const lastUserSeq = users.at(-1);
  const maxToolChars = budget.toolResultMaxTokens * CHARS_PER_TOKEN;

  let stubbedToolResults = 0;
  const tailMessages: ChatCompletionMessageParam[] = [];
  const turnMessages: ChatCompletionMessageParam[] = [];

  // Old load_skill rows become skill cards (core rules), not bare stubs.
  const skillCallNames = new Map<string, string>();
  for (const envelope of live) {
    if (envelope.record.role !== 'assistant') continue;
    for (const call of envelope.record.tool_calls ?? []) {
      if (call.type !== 'function' || call.function.name !== 'load_skill') continue;
      try {
        const args = JSON.parse(call.function.arguments) as { skill_name?: unknown };
        if (typeof args.skill_name === 'string') skillCallNames.set(call.id, args.skill_name);
      } catch {
        // Malformed args never produced a body worth carding.
      }
    }
  }

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

    const skillName =
      envelope.record.role === 'tool'
        ? skillCallNames.get(envelope.record.tool_call_id)
        : undefined;
    let message: ChatCompletionMessageParam | null =
      // A skill body is for the turn that loaded it; later turns get its card.
      (stubTool || !inTurn) && skillName && envelope.record.role === 'tool'
        ? {
            role: 'tool',
            tool_call_id: envelope.record.tool_call_id,
            content: skillCard(skillName),
          }
        : toParam(envelope, stubTool, stubImages);
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

  // Stable layers first, then history, then layers that change between sends
  // (skill picks, plan edits, mentions, last-run note). A plan edit then
  // invalidates only the tail of the prompt, not the whole history prefix.
  const messages: ChatCompletionMessageParam[] = fillOrphanToolResults([
    systemMessage,
    ...(skillsMessage ? [skillsMessage] : []),
    memoryMessage,
    ...(rulesMessage ? [rulesMessage] : []),
    ...(briefMessage ? [briefMessage] : []),
    ...tailMessages,
    ...(bodiesMessage ? [bodiesMessage] : []),
    ...(planMessage ? [planMessage] : []),
    ...(mentionsMessage ? [mentionsMessage] : []),
    ...(lastRunMessage ? [lastRunMessage] : []),
    ...turnMessages,
  ]);

  // Use the assembled messages, not raw ledger content: the prompt may hold
  // stubbed or capped versions of load_skill results, and conversationTokens
  // subtracts this from a total built from those same messages.
  const skillsLoadedTokens = loadSkillTokensFromMessages([
    ...tailMessages,
    ...turnMessages,
  ]);
  const conversationTokens = Math.max(
    0,
    layerTokens([...tailMessages, ...turnMessages]) - skillsLoadedTokens,
  );

  const layers = [
    {
      id: 'system',
      label: 'System',
      tokens: layerTokens([systemMessage]),
    },
    {
      id: 'tools',
      label: 'Tools',
      tokens: layerTokens([], input.tools.definitions),
    },
    {
      id: 'skills_catalog',
      label: 'Skill catalog',
      tokens: skillsText ? charsToTokens(skillsText.length) + 4 : 0,
    },
    {
      id: 'skills_bodies',
      label: 'Attached skill bodies',
      tokens: bodiesText ? charsToTokens(bodiesText.length) + 4 : 0,
    },
    {
      id: 'memory',
      label: 'Memory',
      tokens: charsToTokens(memoryText.length) + 4,
    },
    {
      id: 'rules',
      label: 'Rules',
      tokens: rulesText ? charsToTokens(rulesText.length) + 4 : 0,
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
      id: 'last_run',
      label: 'Last run',
      tokens: lastRunText ? charsToTokens(lastRunText.length) + 4 : 0,
    },
    {
      id: 'conversation',
      label: 'Conversation',
      tokens: conversationTokens,
    },
    {
      id: 'skills_loaded',
      label: 'Loaded skills',
      tokens: skillsLoadedTokens,
    },
  ];

  const occupiedTokens = layers.reduce((sum, layer) => sum + layer.tokens, 0);
  const inputBudget = budget.windowTokens - budget.outputReserveTokens;
  const needsCompaction = occupiedTokens > inputBudget * budget.compactAtRatio;

  const report: ContextReport = {
    budget,
    layers,
    occupiedTokens,
    stubbedToolResults,
    needsCompaction,
    ...(pinned.trimmed.length > 0 ? { trimmedSkills: pinned.trimmed } : {}),
  };

  return { messages, report };
}
