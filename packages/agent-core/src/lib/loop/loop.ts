import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';

import {
  ChoiceSkipped,
  DEFAULT_CONTEXT_BUDGET,
  isAskStrippedTool,
  type LedgerAppendMeta,
  type TokenUsage,
  type ToolContext,
} from '@agent/agent-models';

import {
  refreshContextReport,
  stubLiveToolResults,
} from '../context/assemble-context';
import { consoleTrace, type TraceEvent } from '../events/trace';
import { resolveLimits } from './limits';
import type { ModelTurn } from '../model/types';
import type { Tool, ToolRegistry } from '../tools/type';
import { sha256Text } from '../tools/web-source';
import {
  extractHttpUrls,
  hostListedWebUrls,
  WEB_FETCH_UNTRUSTED_SHA,
  WEB_FETCH_UNTRUSTED_URL,
} from '../tools/web-trust';
import { canonicalizeWebFetchUrl, looksLikeHttpUrl } from '../tools/web-url';
import { toLedgerRecord } from './to-ledger-record';
import type { ModelCallFn, RunLoopConfig, RunLoopResult } from './types';

const OPEN_PLAN_WORK_NUDGE =
  'Open todos remain on the Final plan. Update todo status or finish those items before ending the turn. Do not claim the work is done.';

const USER_SKIPPED_CHOICE =
  'User skipped this choice. Stop. Do not assume a path or keep editing.';

type ToolStage = 'skill' | 'read' | 'network' | 'mutate';

function toolStage(name: string): ToolStage {
  if (name === 'load_skill') return 'skill';
  if (name === 'glob' || name === 'grep' || name === 'read_file') return 'read';
  if (name === 'web_search' || name === 'web_fetch') return 'network';
  return 'mutate';
}

export type {
  ModelCallFn,
  RunLoopConfig,
  RunLoopResult,
  RunLoopStatus,
} from './types';

/* ---------- internal helpers ---------- */

/**
 * Cap for `tool.completed` result previews carried on the live event stream.
 * Large enough to carry a full read_file / run_terminal result for the UI's
 * inline preview; the host ledger still holds the unbounded result. Short
 * status strings (blocked, USER_SKIPPED_CHOICE) keep their own smaller caps.
 */
const RESULT_PREVIEW_MAX = 20_000;

function preview(value: unknown, max = 300): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** Compact preview so UI labels are not poisoned by truncated newText/oldText. */
function toolArgsPreview(toolName: string, args: unknown): string {
  if (
    toolName === 'edit_file' &&
    args &&
    typeof args === 'object' &&
    !Array.isArray(args)
  ) {
    const record = args as Record<string, unknown>;
    const path = typeof record.path === 'string' ? record.path : '';
    const oldText = typeof record.oldText === 'string' ? record.oldText : '';
    const intent = oldText.length > 0 ? 'patch' : 'create';
    return preview({ path, intent }, 200);
  }
  if (
    toolName === 'offer_choice' &&
    args &&
    typeof args === 'object' &&
    !Array.isArray(args)
  ) {
    const record = args as Record<string, unknown>;
    return preview(
      {
        question:
          typeof record.question === 'string'
            ? record.question.slice(0, 120)
            : '',
      },
      200,
    );
  }
  if (
    (toolName === 'plan' || toolName === 'todo') &&
    args &&
    typeof args === 'object' &&
    !Array.isArray(args)
  ) {
    const record = args as Record<string, unknown>;
    if (toolName === 'plan') {
      return preview(
        {
          action: record.action,
          kind: record.kind,
          text:
            typeof record.text === 'string'
              ? record.text.slice(0, 80)
              : undefined,
        },
        200,
      );
    }
    const todos = Array.isArray(record.todos) ? record.todos.length : 0;
    return preview({ merge: record.merge, todos }, 200);
  }
  return preview(args, 200);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function toolCallKey(toolName: string, args: unknown): string {
  if (
    toolName === 'web_fetch' &&
    args !== null &&
    typeof args === 'object' &&
    !Array.isArray(args)
  ) {
    const record = args as Record<string, unknown>;
    if (typeof record.sha256 === 'string' && record.sha256.trim()) {
      return `${toolName}:${canonicalJson({
        sha256: record.sha256.trim().toLowerCase(),
        offset: record.offset ?? 0,
        limit: record.limit ?? 0,
      })}`;
    }
    if (typeof record.url === 'string') {
      return `${toolName}:${canonicalJson({
        url: canonicalizeWebFetchUrl(record.url),
      })}`;
    }
  }
  return `${toolName}:${canonicalJson(args)}`;
}

/** Sync path key for admission/outcome maps — matches jail aliases like ./a vs a. */
function canonicalizeToolPath(raw: string): string {
  let normalized = raw.trim().replaceAll('\\', '/');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  // path.normalize keeps OS separators; re-posix so Windows matches Unix keys.
  return path.normalize(normalized || '.').split(path.sep).join('/');
}

function pathFromToolArgs(args: unknown): string | null {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return null;
  }
  const raw = (args as Record<string, unknown>).path;
  return typeof raw === 'string' && raw.trim() ? canonicalizeToolPath(raw) : null;
}

/**
 * Outcome key for mutate-stage stuck detection. edit_file keys on path+result
 * so varied failing spans on the same file accumulate; other mutates keep
 * call+result (repeat guard already covers identical args).
 */
function outcomeKey(toolName: string, args: unknown, result: string): string {
  const resultHash = sha256Text(result.slice(0, 2000));
  if (toolName === 'edit_file') {
    const filePath = pathFromToolArgs(args) ?? toolCallKey(toolName, args);
    return `${toolName}:${filePath}#${resultHash}`;
  }
  return `${toolCallKey(toolName, args)}#${resultHash}`;
}

/** Invented tool names in one run before hard halt (I1 + I6). */
const MAX_UNKNOWN_TOOL_STREAK = 2;
/** Distinct read_file admits per path per run (stops offset paging storms). */
const MAX_READ_FILE_PER_PATH = 30;
/** run_terminal admits per run (stops shell flood). */
const MAX_TERMINAL_CALLS = 25;
/** Identical mutate call+result before stuck halt. */
const MAX_IDENTICAL_OUTCOMES = 3;

/** Coded tool rows so UI/ledger can tell skips from real results (I1 + observability). */
function limitMessage(
  code:
    | 'limit.repeat'
    | 'limit.tools'
    | 'limit.read_storm'
    | 'limit.terminal'
    | 'limit.unknown'
    | 'limit.outcome'
    | 'limit.iterations'
    | 'limit.plan'
    | 'limit.finish',
  detail: string,
): string {
  return `${code}: ${detail}`;
}

const SKIP_LIMIT_REACHED = limitMessage(
  'limit.tools',
  'Skipped: tool call limit reached.',
);
const REPEAT_BLOCKED = limitMessage(
  'limit.repeat',
  'This exact tool call has already been attempted multiple times. Do not repeat it.',
);

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('Run cancelled');
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason instanceof Error
        ? signal.reason
        : new Error('Run cancelled'),
    );
  }

  if (timeoutMs <= 0) {
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        signal?.removeEventListener('abort', onAbort);
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error('Run cancelled'),
        );
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Tool timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const onAbort = () => {
      cleanup();
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error('Run cancelled'),
      );
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/* ---------- the loop ---------- */

/**
 * The agent state machine. Iterates: model call → tool execution → next model call.
 *
 * Contract: observe tools per *turn* (batch → append every tool_call_id → next
 * model call). Never model-after-each-tool. Gates dispose; prompts do not.
 * Emits AgentEvents via config.emit (for SSE/UI) AND traces via config.trace
 * (for eval/console). Durable turns go through config.onMessage (host ledger).
 */
export async function runLoop(
  modelCall: ModelCallFn,
  messages: ChatCompletionMessageParam[],
  tools: ToolRegistry,
  config: RunLoopConfig,
): Promise<RunLoopResult> {
  const limits = resolveLimits(config.limits);
  const trace = config.trace ?? ((event: TraceEvent) => consoleTrace(event));
  const emit = config.emit;
  const runId = config.runId ?? randomUUID();
  const threadId = config.threadId ?? 'unknown';
  const signal = config.signal;
  const origin = config.origin ?? 'chat';

  let iterations = 0;
  let totalToolCalls = 0;
  let planWorkNudges = 0;
  let unknownToolCount = 0;
  let terminalCalls = 0;
  let lastLimitReason: string | undefined;
  const readFileByPath = new Map<string, number>();
  const repeatedCalls = new Map<string, number>();
  const repeatedOutcomes = new Map<string, number>();

  function noteLimit(reason: string): void {
    lastLimitReason = reason;
    trace({
      type: 'limit',
      runId,
      iteration: iterations,
      reason,
    });
    emit?.({ type: 'limit.hit', runId, reason });
  }
  const contextBudget = config.contextBudget ?? DEFAULT_CONTEXT_BUDGET;
  const trustedWebUrls = new Set<string>();
  const trustedWebShas = new Set<string>();
  const webBodies = new Map<string, string>();
  const webMeta = new Map<string, { url: string; title: string }>();
  const urlToSha = new Map<string, string>();

  function noteTrustedWebUrls(urls: string[]): void {
    for (const raw of urls) {
      const trimmed = raw.trim();
      if (!looksLikeHttpUrl(trimmed)) continue;
      trustedWebUrls.add(canonicalizeWebFetchUrl(trimmed));
    }
  }

  function noteWebSource(source: {
    sha256: string;
    url: string;
    title: string;
    content: string;
  }): void {
    const sha = source.sha256.toLowerCase();
    trustedWebShas.add(sha);
    webBodies.set(sha, source.content);
    webMeta.set(sha, {
      url: canonicalizeWebFetchUrl(source.url),
      title: source.title,
    });
    urlToSha.set(canonicalizeWebFetchUrl(source.url), sha);
    noteTrustedWebUrls([source.url]);
  }

  async function putBlob(text: string): Promise<string> {
    if (config.putBlob) {
      const sha = (await config.putBlob(text)).toLowerCase();
      webBodies.set(sha, text);
      return sha;
    }
    const sha = sha256Text(text);
    webBodies.set(sha, text);
    return sha;
  }

  async function getWebSource(
    sha256: string,
  ): Promise<
    { sha256: string; url: string; title: string; content: string } | undefined
  > {
    const sha = sha256.toLowerCase();
    if (!trustedWebShas.has(sha)) return undefined;
    let content = webBodies.get(sha);
    if (!content && config.readBlob) {
      content = await config.readBlob(sha);
      if (content) webBodies.set(sha, content);
    }
    if (!content) return undefined;
    const meta = webMeta.get(sha) ?? { url: '', title: '' };
    return { sha256: sha, url: meta.url, title: meta.title, content };
  }

  function getWebSourceByUrl(url: string): string | undefined {
    return urlToSha.get(canonicalizeWebFetchUrl(url));
  }

  function seedTrustedWebUrls(): void {
    for (const message of messages) {
      if (typeof message.content !== 'string') continue;
      if (message.role === 'user') {
        noteTrustedWebUrls(extractHttpUrls(message.content));
      } else if (message.role === 'tool') {
        noteTrustedWebUrls(hostListedWebUrls(message.content));
        const sha = message.content.match(/^sha256: ([a-f0-9]{64})$/m)?.[1];
        const url = message.content.match(/^URL: (.+)$/m)?.[1]?.trim();
        const title = message.content.match(/^title: (.+)$/m)?.[1]?.trim();
        if (sha) {
          const id = sha.toLowerCase();
          trustedWebShas.add(id);
          if (url) {
            const canonical = canonicalizeWebFetchUrl(url);
            webMeta.set(id, { url: canonical, title: title ?? '' });
            urlToSha.set(canonical, id);
            noteTrustedWebUrls([canonical]);
          }
        }
      }
    }
  }

  seedTrustedWebUrls();

  async function appendDurable(
    message: ChatCompletionMessageParam,
    meta?: LedgerAppendMeta,
  ): Promise<void> {
    messages.push(message);
    if (config.onMessage) {
      await config.onMessage(toLedgerRecord(message), meta);
    }
  }

  function isToolAnswered(toolCallId: string): boolean {
    return messages.some(
      (message) =>
        message.role === 'tool' &&
        'tool_call_id' in message &&
        message.tool_call_id === toolCallId,
    );
  }

  function unansweredToolCalls(
    toolCalls: ChatCompletionMessageToolCall[],
  ): ChatCompletionMessageToolCall[] {
    return toolCalls.filter((toolCall) => !isToolAnswered(toolCall.id));
  }

  /** I1: every tool_call_id gets one durable tool row; never double-answer. */
  async function skipToolCalls(
    toolCalls: ChatCompletionMessageToolCall[],
    reason: string,
  ): Promise<void> {
    for (const toolCall of toolCalls) {
      if (isToolAnswered(toolCall.id)) continue;
      await appendDurable({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: reason,
      });
    }
  }

  function buildToolContext(): ToolContext {
    return {
      runId,
      threadId,
      origin,
      signal: signal ?? new AbortController().signal,
      ...(config.workspaceRoot !== undefined
        ? { workspaceRoot: config.workspaceRoot }
        : {}),
      ...(config.offerChoice ? { offerChoice: config.offerChoice } : {}),
      putBlob,
      ...(config.readBlob
        ? {
            readBlob: async (sha, offset, length) => {
              const source = await getWebSource(sha);
              if (source) {
                if (offset === undefined && length === undefined) {
                  return source.content;
                }
                const start = offset ?? 0;
                return source.content.slice(
                  start,
                  length === undefined ? undefined : start + length,
                );
              }
              return config.readBlob!(sha, offset, length);
            },
          }
        : {}),
      noteTrustedWebUrls,
      noteWebSource,
      getWebSource,
      getWebSourceByUrl,
    };
  }

  function emitTurnCompleted(iteration: number, usage?: TokenUsage): void {
    const contextReport = config.contextReport
      ? refreshContextReport(config.contextReport, messages, tools, usage)
      : undefined;
    emit?.({
      type: 'turn.completed',
      runId,
      iteration,
      ...(usage ? { usage } : {}),
      ...(contextReport ? { contextReport } : {}),
    });
  }

  type ReadyToolCall = {
    toolCall: ChatCompletionMessageToolCall;
    toolName: string;
    tool: Tool;
    args: Record<string, unknown>;
  };

  type AdmitResult =
    | { kind: 'ready'; call: ReadyToolCall }
    | { kind: 'filled' }
    | {
        kind: 'halt';
        reason: 'limit' | 'repeat';
        toolCall: ChatCompletionMessageToolCall;
      };

  async function admitToolCall(
    toolCall: ChatCompletionMessageToolCall,
  ): Promise<AdmitResult> {
    if (toolCall.type !== 'function') {
      await appendDurable({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: 'Unsupported tool call type.',
      });
      return { kind: 'filled' };
    }

    const toolName = toolCall.function.name;
    const tool = tools.byName.get(toolName);

    // Rejects always get a tool row (I1) but do not burn maxToolCalls (D10).
    if (!tool) {
      await appendDurable({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: `Tool "${toolName}" does not exist.`,
      });
      unknownToolCount += 1;
      if (unknownToolCount >= MAX_UNKNOWN_TOOL_STREAK) {
        noteLimit(
          limitMessage(
            'limit.unknown',
            `unknown tool streak exceeded (${MAX_UNKNOWN_TOOL_STREAK})`,
          ),
        );
        return { kind: 'halt', reason: 'limit', toolCall };
      }
      return { kind: 'filled' };
    }

    // Valid tool breaks the unknown streak (lifetime total was ending runs early).
    unknownToolCount = 0;

    if (posture === 'ask' && isAskStrippedTool(toolName)) {
      const blocked =
        'Blocked: this run is Ask (read-only). Switch the composer to Agent to edit files or run commands.';
      emit?.({
        type: 'tool.started',
        runId,
        toolCallId: toolCall.id,
        toolName,
        argsPreview: toolArgsPreview(toolName, {}),
      });
      emit?.({
        type: 'tool.completed',
        runId,
        toolCallId: toolCall.id,
        toolName,
        durationMs: 0,
        resultPreview: preview(blocked, 200),
      });
      await appendDurable({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: blocked,
      });
      return { kind: 'filled' };
    }

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      await appendDurable({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: 'Invalid tool arguments. Expected valid JSON.',
      });
      return { kind: 'filled' };
    }

    if (toolName === 'web_fetch') {
      const sha =
        typeof args.sha256 === 'string' ? args.sha256.trim().toLowerCase() : '';
      const url = typeof args.url === 'string' ? args.url.trim() : '';
      if (sha) {
        if (!trustedWebShas.has(sha)) {
          const blocked = WEB_FETCH_UNTRUSTED_SHA;
          emit?.({
            type: 'tool.started',
            runId,
            toolCallId: toolCall.id,
            toolName,
            argsPreview: toolArgsPreview(toolName, args),
          });
          emit?.({
            type: 'tool.completed',
            runId,
            toolCallId: toolCall.id,
            toolName,
            durationMs: 0,
            resultPreview: preview(blocked, 200),
          });
          await appendDurable({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: blocked,
          });
          return { kind: 'filled' };
        }
      } else if (looksLikeHttpUrl(url)) {
        const canonical = canonicalizeWebFetchUrl(url);
        if (!trustedWebUrls.has(canonical)) {
          const blocked = WEB_FETCH_UNTRUSTED_URL;
          emit?.({
            type: 'tool.started',
            runId,
            toolCallId: toolCall.id,
            toolName,
            argsPreview: toolArgsPreview(toolName, args),
          });
          emit?.({
            type: 'tool.completed',
            runId,
            toolCallId: toolCall.id,
            toolName,
            durationMs: 0,
            resultPreview: preview(blocked, 200),
          });
          await appendDurable({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: blocked,
          });
          return { kind: 'filled' };
        }
      }
    } else if (toolName === 'web_search') {
      const candidate = String(args.query ?? '').trim();
      if (looksLikeHttpUrl(candidate)) {
        const canonical = canonicalizeWebFetchUrl(candidate);
        if (!trustedWebUrls.has(canonical)) {
          const blocked = WEB_FETCH_UNTRUSTED_URL;
          emit?.({
            type: 'tool.started',
            runId,
            toolCallId: toolCall.id,
            toolName,
            argsPreview: toolArgsPreview(toolName, args),
          });
          emit?.({
            type: 'tool.completed',
            runId,
            toolCallId: toolCall.id,
            toolName,
            durationMs: 0,
            resultPreview: preview(blocked, 200),
          });
          await appendDurable({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: blocked,
          });
          return { kind: 'filled' };
        }
      }
    }

    const readPath =
      toolName === 'read_file' ? pathFromToolArgs(args) : null;
    if (readPath !== null) {
      const pathCount = readFileByPath.get(readPath) ?? 0;
      if (pathCount >= MAX_READ_FILE_PER_PATH) {
        noteLimit(
          limitMessage(
            'limit.read_storm',
            `read_file path storm blocked (${MAX_READ_FILE_PER_PATH} per path)`,
          ),
        );
        return { kind: 'halt', reason: 'limit', toolCall };
      }
    }

    if (toolName === 'run_terminal' && terminalCalls >= MAX_TERMINAL_CALLS) {
      noteLimit(
        limitMessage(
          'limit.terminal',
          `run_terminal storm blocked (${MAX_TERMINAL_CALLS} per run)`,
        ),
      );
      return { kind: 'halt', reason: 'limit', toolCall };
    }

    if (
      limits.maxToolCalls !== undefined &&
      totalToolCalls >= limits.maxToolCalls
    ) {
      noteLimit(
        limitMessage(
          'limit.tools',
          `max tool calls exceeded (${limits.maxToolCalls})`,
        ),
      );
      return { kind: 'halt', reason: 'limit', toolCall };
    }

    const callKey = toolCallKey(toolName, args);
    const repeatCount = (repeatedCalls.get(callKey) ?? 0) + 1;
    repeatedCalls.set(callKey, repeatCount);

    if (repeatCount > limits.maxRepeatedToolCalls) {
      noteLimit(
        limitMessage('limit.repeat', `repeated tool call blocked: ${toolName}`),
      );
      return { kind: 'halt', reason: 'repeat', toolCall };
    }

    totalToolCalls += 1;
    if (readPath !== null) {
      readFileByPath.set(readPath, (readFileByPath.get(readPath) ?? 0) + 1);
    }
    if (toolName === 'run_terminal') {
      terminalCalls += 1;
    }

    return {
      kind: 'ready',
      call: { toolCall, toolName, tool, args },
    };
  }

  async function finishHalt(
    halt: Extract<AdmitResult, { kind: 'halt' }>,
    fromIndex: number,
    toolCalls: ChatCompletionMessageToolCall[],
  ): Promise<RunLoopResult> {
    const triggerAnswered = isToolAnswered(halt.toolCall.id);
    if (halt.reason === 'repeat') {
      if (!triggerAnswered) {
        await appendDurable({
          role: 'tool',
          tool_call_id: halt.toolCall.id,
          content: REPEAT_BLOCKED,
        });
      }
      await skipToolCalls(toolCalls.slice(fromIndex + 1), SKIP_LIMIT_REACHED);
    } else if (triggerAnswered) {
      await skipToolCalls(toolCalls.slice(fromIndex + 1), SKIP_LIMIT_REACHED);
    } else {
      await skipToolCalls(toolCalls.slice(fromIndex), SKIP_LIMIT_REACHED);
    }
    return completeAfterLimit();
  }

  function lastAssistantContent(): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role !== 'assistant') continue;
      return typeof message.content === 'string' ? message.content : '';
    }
    return '';
  }

  function finishChoiceSkipped(): RunLoopResult {
    emitTurnCompleted(iterations);
    emit?.({
      type: 'run.completed',
      runId,
      iterations,
      toolCalls: totalToolCalls,
      incomplete: true,
    });
    return {
      runId,
      content: lastAssistantContent(),
      iterations,
      toolCalls: totalToolCalls,
      status: 'incomplete',
    };
  }

  async function executeReadyCall(
    call: ReadyToolCall,
    remainingOnAbort: ChatCompletionMessageToolCall[],
  ): Promise<'ok' | 'deferred' | 'halted'> {
    const { toolCall, toolName, tool, args } = call;
    const toolCtx = buildToolContext();

    trace({
      type: 'tool_start',
      runId,
      iteration: iterations,
      toolName,
      args,
    });
    emit?.({
      type: 'tool.started',
      runId,
      toolCallId: toolCall.id,
      toolName,
      argsPreview: toolArgsPreview(toolName, args),
    });

    const startedAt = Date.now();

    try {
      // exec tools own their timeout + process-tree kill (workspace.ts).
      // The loop's withTimeout would race the tool's timer and leak the child.
      const ownsTimeout = toolName === 'offer_choice' || tool.risk === 'exec';
      const result = await withTimeout(
        tool.execute(args, toolCtx),
        ownsTimeout ? 0 : limits.toolTimeoutMs,
        signal,
      );
      const durationMs = Date.now() - startedAt;
      trace({
        type: 'tool_complete',
        runId,
        iteration: iterations,
        toolName,
        durationMs,
        resultPreview: preview(result),
      });
      emit?.({
        type: 'tool.completed',
        runId,
        toolCallId: toolCall.id,
        toolName,
        durationMs,
        resultPreview: preview(result, RESULT_PREVIEW_MAX),
      });
      // Append before outcome halt so I1 always holds for the triggering call.
      await appendDurable({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result,
      });
      // Mutate-stage only: same call + same result = stuck (e.g. write theater).
      if (toolStage(toolName) === 'mutate') {
        const key = outcomeKey(toolName, args, result);
        const outcomeCount = (repeatedOutcomes.get(key) ?? 0) + 1;
        repeatedOutcomes.set(key, outcomeCount);
        if (outcomeCount >= MAX_IDENTICAL_OUTCOMES) {
          noteLimit(
            limitMessage(
              'limit.outcome',
              `repeated identical tool outcome blocked: ${toolName}`,
            ),
          );
          return 'halted';
        }
      }
      return 'ok';
    } catch (error) {
      if (signal?.aborted) {
        await skipToolCalls(remainingOnAbort, 'Skipped: run cancelled.');
        throwIfAborted(signal);
      }
      if (error instanceof ChoiceSkipped) {
        emit?.({
          type: 'tool.completed',
          runId,
          toolCallId: toolCall.id,
          toolName,
          durationMs: Date.now() - startedAt,
          resultPreview: preview(USER_SKIPPED_CHOICE, 200),
        });
        await appendDurable({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: USER_SKIPPED_CHOICE,
        });
        await skipToolCalls(
          remainingOnAbort.slice(1),
          'Skipped: user deferred this choice.',
        );
        return 'deferred';
      }
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      trace({
        type: 'tool_error',
        runId,
        iteration: iterations,
        toolName,
        error: errorMessage,
      });
      emit?.({
        type: 'tool.failed',
        runId,
        toolCallId: toolCall.id,
        error: errorMessage,
      });
      await appendDurable({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: `Tool execution failed: ${errorMessage}`,
      });
      return 'ok';
    }
  }

  async function executeReadyBatch(
    batch: ReadyToolCall[],
    remainingAfter: ChatCompletionMessageToolCall[],
  ): Promise<'ok' | 'deferred' | 'halted'> {
    // write/exec and interactive tools stay serial even if they slip into a batch.
    if (
      batch.length === 1 ||
      batch.some((call) => {
        const risk = call.tool.risk ?? 'read';
        return (
          risk === 'write' ||
          risk === 'exec' ||
          call.toolName === 'offer_choice'
        );
      })
    ) {
      for (let i = 0; i < batch.length; i++) {
        const call = batch[i];
        if (!call) continue;
        const outcome = await executeReadyCall(call, [
          ...batch.slice(i).map((item) => item.toolCall),
          ...remainingAfter,
        ]);
        if (outcome !== 'ok') return outcome;
      }
      return 'ok';
    }

    const toolCtx = buildToolContext();
    for (const call of batch) {
      trace({
        type: 'tool_start',
        runId,
        iteration: iterations,
        toolName: call.toolName,
        args: call.args,
      });
      emit?.({
        type: 'tool.started',
        runId,
        toolCallId: call.toolCall.id,
        toolName: call.toolName,
        argsPreview: toolArgsPreview(call.toolName, call.args),
      });
    }

    const settled = await Promise.all(
      batch.map(async (call) => {
        const started = Date.now();
        try {
          // exec tools own their timeout + process-tree kill.
          const ownsTimeout =
            call.toolName === 'offer_choice' || call.tool.risk === 'exec';
          const result = await withTimeout(
            call.tool.execute(call.args, toolCtx),
            ownsTimeout ? 0 : limits.toolTimeoutMs,
            signal,
          );
          return {
            call,
            ok: true as const,
            result,
            durationMs: Date.now() - started,
          };
        } catch (error) {
          return {
            call,
            ok: false as const,
            error,
            durationMs: Date.now() - started,
          };
        }
      }),
    );

    if (signal?.aborted) {
      await skipToolCalls(
        [...batch.map((call) => call.toolCall), ...remainingAfter],
        'Skipped: run cancelled.',
      );
      throwIfAborted(signal);
    }

    let outcomeHalted = false;
    for (const item of settled) {
      const { call, durationMs } = item;
      if (item.ok) {
        trace({
          type: 'tool_complete',
          runId,
          iteration: iterations,
          toolName: call.toolName,
          durationMs,
          resultPreview: preview(item.result),
        });
        emit?.({
          type: 'tool.completed',
          runId,
          toolCallId: call.toolCall.id,
          toolName: call.toolName,
          durationMs,
          resultPreview: preview(item.result, RESULT_PREVIEW_MAX),
        });
        await appendDurable({
          role: 'tool',
          tool_call_id: call.toolCall.id,
          content: item.result,
        });
        // Mutate-stage only; finish appending the batch before returning halted.
        if (toolStage(call.toolName) === 'mutate') {
          const key = outcomeKey(call.toolName, call.args, item.result);
          const outcomeCount = (repeatedOutcomes.get(key) ?? 0) + 1;
          repeatedOutcomes.set(key, outcomeCount);
          if (outcomeCount >= MAX_IDENTICAL_OUTCOMES) {
            noteLimit(
              limitMessage(
                'limit.outcome',
                `repeated identical tool outcome blocked: ${call.toolName}`,
              ),
            );
            outcomeHalted = true;
          }
        }
        continue;
      }

      if (signal?.aborted) {
        await skipToolCalls(
          [
            call.toolCall,
            ...settled
              .slice(settled.indexOf(item) + 1)
              .map((entry) => entry.call.toolCall),
            ...remainingAfter,
          ],
          'Skipped: run cancelled.',
        );
        throwIfAborted(signal);
      }

      if (item.error instanceof ChoiceSkipped) {
        emit?.({
          type: 'tool.completed',
          runId,
          toolCallId: call.toolCall.id,
          toolName: call.toolName,
          durationMs,
          resultPreview: preview(USER_SKIPPED_CHOICE, 200),
        });
        await appendDurable({
          role: 'tool',
          tool_call_id: call.toolCall.id,
          content: USER_SKIPPED_CHOICE,
        });
        await skipToolCalls(
          [
            ...settled
              .slice(settled.indexOf(item) + 1)
              .map((entry) => entry.call.toolCall),
            ...remainingAfter,
          ],
          'Skipped: user deferred this choice.',
        );
        return 'deferred';
      }

      const errorMessage =
        item.error instanceof Error ? item.error.message : String(item.error);
      trace({
        type: 'tool_error',
        runId,
        iteration: iterations,
        toolName: call.toolName,
        error: errorMessage,
      });
      emit?.({
        type: 'tool.failed',
        runId,
        toolCallId: call.toolCall.id,
        error: errorMessage,
      });
      await appendDurable({
        role: 'tool',
        tool_call_id: call.toolCall.id,
        content: `Tool execution failed: ${errorMessage}`,
      });
    }
    return outcomeHalted ? 'halted' : 'ok';
  }

  /** Fresh message lifecycle for limit finalization (never reuse the tool-turn id). */
  async function finalizeAnswer(): Promise<{
    content: string;
    usage?: TokenUsage;
  }> {
    const finalMessageId = randomUUID();
    const onTextDelta = (delta: string) => {
      emit?.({
        type: 'assistant.delta',
        runId,
        messageId: finalMessageId,
        delta,
      });
    };

    emit?.({ type: 'assistant.started', runId, messageId: finalMessageId });

    // duration = model-call + stream time; excludes tool execution (on ToolCompleted).
    const startedAt = Date.now();
    const turn = await finalizeWithoutTools(
      modelCall,
      config.model,
      messages,
      onTextDelta,
      signal,
    );
    const content = turn.content ?? '';
    const durationMs = Date.now() - startedAt;

    await appendDurable(
      {
        role: 'assistant',
        content,
      },
      { durationMs },
    );

    emit?.({
      type: 'assistant.completed',
      runId,
      messageId: finalMessageId,
      content,
      durationMs,
    });

    return { content, usage: turn.usage };
  }

  async function completeAfterLimit(): Promise<RunLoopResult> {
    stubLiveToolResults(messages, contextBudget);
    const final = await finalizeAnswer();
    trace({
      type: 'run_finish',
      runId,
      iterations,
      toolCalls: totalToolCalls,
    });
    emitTurnCompleted(iterations, final.usage);
    emit?.({
      type: 'run.completed',
      runId,
      iterations,
      toolCalls: totalToolCalls,
      incomplete: true,
      ...(lastLimitReason ? { limitReason: lastLimitReason } : {}),
    });
    return {
      runId,
      content: final.content,
      iterations,
      toolCalls: totalToolCalls,
      status: 'incomplete',
      ...(lastLimitReason ? { limitReason: lastLimitReason } : {}),
    };
  }

  trace({ type: 'run_start', runId, model: config.model });
  const posture = config.posture ?? 'agent';
  emit?.({
    type: 'run.started',
    runId,
    threadId,
    mode: config.mode,
    posture,
    model: config.model,
    ...(config.estimatedPromptTokens !== undefined
      ? { estimatedPromptTokens: config.estimatedPromptTokens }
      : {}),
    ...(config.contextReport ? { contextReport: config.contextReport } : {}),
  });

  try {
    while (
      limits.maxIterations === undefined ||
      iterations < limits.maxIterations
    ) {
      throwIfAborted(signal);
      iterations++;

      trace({ type: 'llm_request', runId, iteration: iterations });
      emit?.({ type: 'turn.started', runId, iteration: iterations });

      const messageId = randomUUID();
      const onTextDelta = (delta: string) => {
        emit?.({
          type: 'assistant.delta',
          runId,
          messageId,
          delta,
        });
      };

      emit?.({ type: 'assistant.started', runId, messageId });

      // duration = model-call + stream time; excludes tool execution (on ToolCompleted).
      const startedAt = Date.now();
      const turn = await modelCall(
        config.model,
        messages,
        tools,
        onTextDelta,
        signal,
      );
      throwIfAborted(signal);
      const durationMs = Date.now() - startedAt;

      trace({
        type: 'llm_response',
        runId,
        iteration: iterations,
        finishReason: turn.finishReason,
        hasToolCalls: Boolean(turn.toolCalls.length),
        contentPreview: turn.content ? preview(turn.content) : undefined,
      });

      if (turn.toolCalls.length > 0) {
        await appendDurable(
          {
            role: 'assistant',
            content: turn.content || null,
            tool_calls: turn.toolCalls,
          },
          { durationMs },
        );

        // Tool turns end like any other: the ledger row is durable, so the
        // client can settle this assistant message before tools run.
        emit?.({
          type: 'assistant.completed',
          runId,
          messageId,
          content: turn.content,
          durationMs,
        });

        const ready: ReadyToolCall[] = [];
        let halt: Extract<AdmitResult, { kind: 'halt' }> | null = null;
        let haltIndex = 0;
        for (let index = 0; index < turn.toolCalls.length; index++) {
          if (signal?.aborted) {
            await skipToolCalls(
              turn.toolCalls.slice(index),
              'Skipped: run cancelled.',
            );
            throwIfAborted(signal);
          }

          const toolCall = turn.toolCalls[index];
          if (!toolCall || toolCall.type !== 'function') continue;

          const admitted = await admitToolCall(toolCall);
          if (admitted.kind === 'halt') {
            halt = admitted;
            haltIndex = index;
            break;
          }
          if (admitted.kind === 'filled') continue;
          ready.push(admitted.call);
        }

        const staged: Record<ToolStage, ReadyToolCall[]> = {
          skill: [],
          read: [],
          network: [],
          mutate: [],
        };
        for (const call of ready) {
          staged[toolStage(call.toolName)].push(call);
        }

        const runSerial = async (batch: ReadyToolCall[]) => {
          for (let i = 0; i < batch.length; i++) {
            const call = batch[i];
            if (!call) continue;
            const outcome = await executeReadyCall(
              call,
              batch.slice(i).map((item) => item.toolCall),
            );
            if (outcome !== 'ok') return outcome;
          }
          return 'ok' as const;
        };

        // I4 staging: skill → read → network → mutate. Abort only on
        // deferred|halted — never short-circuit on truthy 'ok'.
        let batchOutcome: 'ok' | 'deferred' | 'halted' = 'ok';
        for (const stageBatch of [staged.skill, staged.read] as const) {
          batchOutcome = await executeReadyBatch(stageBatch, []);
          if (batchOutcome !== 'ok') break;
        }
        if (batchOutcome === 'ok') {
          for (const stageBatch of [staged.network, staged.mutate] as const) {
            batchOutcome = await runSerial(stageBatch);
            if (batchOutcome !== 'ok') break;
          }
        }
        if (batchOutcome === 'deferred') {
          return finishChoiceSkipped();
        }
        if (batchOutcome === 'halted') {
          const skipDetail = lastLimitReason?.startsWith('limit.outcome:')
            ? limitMessage('limit.outcome', 'Skipped: tool call limit reached.')
            : SKIP_LIMIT_REACHED;
          await skipToolCalls(unansweredToolCalls(turn.toolCalls), skipDetail);
          return completeAfterLimit();
        }
        if (halt) {
          return finishHalt(halt, haltIndex, turn.toolCalls);
        }

        stubLiveToolResults(messages, contextBudget);
        emitTurnCompleted(iterations, turn.usage);
        continue;
      }

      // No tool calls — this is the final assistant response.
      await appendDurable(
        {
          role: 'assistant',
          content: turn.content ?? '',
        },
        { durationMs },
      );

      emit?.({
        type: 'assistant.completed',
        runId,
        messageId,
        content: turn.content,
        durationMs,
      });

      if (turn.finishReason === 'stop') {
        const result = turn.content ?? '';
        const openPlanWork = config.hasOpenPlanWork
          ? await config.hasOpenPlanWork()
          : false;

        if (openPlanWork && planWorkNudges < 1) {
          planWorkNudges += 1;
          messages.push({
            role: 'user',
            content: OPEN_PLAN_WORK_NUDGE,
          });
          emitTurnCompleted(iterations, turn.usage);
          continue;
        }

        if (openPlanWork) {
          noteLimit(limitMessage('limit.plan', 'Open plan todos remain'));
          emitTurnCompleted(iterations, turn.usage);
          emit?.({
            type: 'run.completed',
            runId,
            iterations,
            toolCalls: totalToolCalls,
            incomplete: true,
            ...(lastLimitReason ? { limitReason: lastLimitReason } : {}),
          });
          return {
            runId,
            content: result,
            iterations,
            toolCalls: totalToolCalls,
            status: 'incomplete',
            ...(lastLimitReason ? { limitReason: lastLimitReason } : {}),
          };
        }

        trace({
          type: 'run_finish',
          runId,
          iterations,
          toolCalls: totalToolCalls,
        });
        emitTurnCompleted(iterations, turn.usage);
        emit?.({
          type: 'run.completed',
          runId,
          iterations,
          toolCalls: totalToolCalls,
        });

        return {
          runId,
          content: result,
          iterations,
          toolCalls: totalToolCalls,
          status: 'completed',
        };
      }

      noteLimit(
        limitMessage(
          'limit.finish',
          `unexpected finish reason: ${turn.finishReason}`,
        ),
      );
      emitTurnCompleted(iterations, turn.usage);
      emit?.({
        type: 'run.completed',
        runId,
        iterations,
        toolCalls: totalToolCalls,
        incomplete: true,
        ...(lastLimitReason ? { limitReason: lastLimitReason } : {}),
      });

      return {
        runId,
        content: turn.content ?? '',
        iterations,
        toolCalls: totalToolCalls,
        status: 'incomplete',
        ...(lastLimitReason ? { limitReason: lastLimitReason } : {}),
      };
    }

    // Max iterations exceeded — finalize without tools.
    noteLimit(
      limitMessage(
        'limit.iterations',
        `max iterations exceeded (${limits.maxIterations})`,
      ),
    );

    return completeAfterLimit();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    trace({
      type: 'tool_error',
      runId,
      iteration: iterations,
      toolName: 'agent',
      error: message,
    });
    emit?.({ type: 'run.error', runId, error: message });

    return {
      runId,
      content: `Agent error: ${message}`,
      iterations,
      toolCalls: totalToolCalls,
      status: 'error',
    };
  }
}

/**
 * Finalize the answer after a limit without offering tools.
 * The steering prompt joins the live `messages` array only — it is loop
 * control flow, not a durable turn, so it must never hit onMessage.
 */
async function finalizeWithoutTools(
  modelCall: ModelCallFn,
  model: string,
  messages: ChatCompletionMessageParam[],
  onTextDelta: ((delta: string) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<ModelTurn> {
  messages.push({
    role: 'user',
    content:
      'Tool budget reached. Answer my original question now using only the information above, and say what is uncertain.',
  });

  return modelCall(
    model,
    messages,
    {
      definitions: [],
      byName: new Map(),
    },
    onTextDelta,
    signal,
  );
}
