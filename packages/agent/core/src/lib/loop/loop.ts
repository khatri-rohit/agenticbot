import { randomUUID } from 'node:crypto';
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';

import {
  ApprovalDenied,
  ChoiceSkipped,
  DEFAULT_CONTEXT_BUDGET,
  isAskStrippedTool,
  type TokenUsage,
  type ToolContext,
} from '@org/agent-models';

import { stubLiveToolResults } from '../context/assemble-context';
import { consoleTrace, type TraceEvent } from '../events/trace';
import { DEFAULT_LIMITS } from './limits';
import type { ModelTurn } from '../model/types';
import type { Tool, ToolRegistry } from '../tools/type';
import { toLedgerRecord } from './to-ledger-record';
import type { ModelCallFn, RunLoopConfig, RunLoopResult } from './types';

const OPEN_PLAN_WORK_NUDGE =
  'Open todos remain on the Final plan. Update todo status or finish those items before ending the turn. Do not claim the work is done.';

/** Write/exec the human must confirm. Plan/todo/memory stay unpaused. */
const LOOP_APPROVAL_TOOLS = new Set(['edit_file', 'run_terminal']);

const USER_DENIED =
  'Denied by the user. Do not retry this exact call unless they ask again.';

const USER_SKIPPED_CHOICE =
  'User skipped this choice. Stop. Do not assume a path or keep editing.';

function isParallelSafeTool(tool: Tool | undefined): boolean {
  if (!tool) return false;
  const risk = tool.risk ?? 'read';
  return risk === 'read' || risk === 'network';
}

export type {
  ModelCallFn,
  RunLoopConfig,
  RunLoopResult,
  RunLoopStatus,
} from './types';

/* ---------- internal helpers ---------- */

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
    (toolName === 'ask_user' || toolName === 'offer_choice') &&
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
  return `${toolName}:${canonicalJson(args)}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('Run cancelled');
}

function approvalSummary(
  toolName: string,
  args: Record<string, unknown>,
): string {
  if (toolName === 'edit_file') {
    const filePath = typeof args.path === 'string' ? args.path : '';
    const oldText = typeof args.oldText === 'string' ? args.oldText : '';
    const intent = oldText.length > 0 ? 'patch' : 'create';
    return `${intent} ${filePath}`.trim();
  }
  if (toolName === 'run_terminal') {
    const command = typeof args.command === 'string' ? args.command : '';
    return command.length > 200 ? `${command.slice(0, 200)}…` : command;
  }
  return toolName;
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
 * Emits AgentEvents via config.emit (for SSE/UI) AND traces via config.trace
 * (for eval/console). Both are optional — the loop works with either or both.
 * Durable turns go through config.onMessage (host persistence seam).
 */
export async function runLoop(
  modelCall: ModelCallFn,
  messages: ChatCompletionMessageParam[],
  tools: ToolRegistry,
  config: RunLoopConfig,
): Promise<RunLoopResult> {
  const limits = { ...DEFAULT_LIMITS, ...config.limits };
  const trace = config.trace ?? ((event: TraceEvent) => consoleTrace(event));
  const emit = config.emit;
  const runId = config.runId ?? randomUUID();
  const threadId = config.threadId ?? 'unknown';
  const signal = config.signal;
  const origin = config.origin ?? 'chat';

  let iterations = 0;
  let totalToolCalls = 0;
  let planWorkNudges = 0;
  const repeatedCalls = new Map<string, number>();
  const contextBudget = config.contextBudget ?? DEFAULT_CONTEXT_BUDGET;

  async function appendDurable(
    message: ChatCompletionMessageParam,
  ): Promise<void> {
    messages.push(message);
    if (config.onMessage) {
      await config.onMessage(toLedgerRecord(message));
    }
  }

  async function skipToolCalls(
    toolCalls: ChatCompletionMessageToolCall[],
    reason: string,
  ): Promise<void> {
    for (const toolCall of toolCalls) {
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
      ...(config.approve ? { approve: config.approve } : {}),
      ...(config.offerChoice ? { offerChoice: config.offerChoice } : {}),
    };
  }

  function emitTurnCompleted(iteration: number, usage?: TokenUsage): void {
    emit?.({
      type: 'turn.completed',
      runId,
      iteration,
      ...(usage ? { usage } : {}),
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

    totalToolCalls++;

    if (totalToolCalls > limits.maxToolCalls) {
      trace({
        type: 'limit',
        runId,
        iteration: iterations,
        reason: `max tool calls exceeded (${limits.maxToolCalls})`,
      });
      emit?.({
        type: 'limit.hit',
        runId,
        reason: `max tool calls exceeded (${limits.maxToolCalls})`,
      });
      return { kind: 'halt', reason: 'limit', toolCall };
    }

    const toolName = toolCall.function.name;
    const tool = tools.byName.get(toolName);

    if (!tool) {
      await appendDurable({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: `Tool "${toolName}" does not exist.`,
      });
      return { kind: 'filled' };
    }

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

    const callKey = toolCallKey(toolName, args);
    const repeatCount = (repeatedCalls.get(callKey) ?? 0) + 1;
    repeatedCalls.set(callKey, repeatCount);

    if (repeatCount > limits.maxRepeatedToolCalls) {
      trace({
        type: 'limit',
        runId,
        iteration: iterations,
        reason: `repeated tool call blocked: ${toolName}`,
      });
      emit?.({
        type: 'limit.hit',
        runId,
        reason: `repeated tool call blocked: ${toolName}`,
      });
      return { kind: 'halt', reason: 'repeat', toolCall };
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
    if (halt.reason === 'repeat') {
      await appendDurable({
        role: 'tool',
        tool_call_id: halt.toolCall.id,
        content:
          'This exact tool call has already been attempted multiple times. Do not repeat it.',
      });
      await skipToolCalls(
        toolCalls.slice(fromIndex + 1),
        'Skipped: tool call limit reached.',
      );
    } else {
      await skipToolCalls(
        toolCalls.slice(fromIndex),
        'Skipped: tool call limit reached.',
      );
    }
    return completeAfterLimit();
  }

  async function completeAsDenied(call: ReadyToolCall): Promise<'ok'> {
    emit?.({
      type: 'tool.completed',
      runId,
      toolCallId: call.toolCall.id,
      toolName: call.toolName,
      durationMs: 0,
      resultPreview: preview(USER_DENIED, 200),
    });
    await appendDurable({
      role: 'tool',
      tool_call_id: call.toolCall.id,
      content: USER_DENIED,
    });
    return 'ok';
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
  ): Promise<'ok' | 'deferred'> {
    const { toolCall, toolName, tool, args } = call;
    const toolCtx = buildToolContext();

    if (LOOP_APPROVAL_TOOLS.has(toolName) && config.approve) {
      try {
        await config.approve({
          toolName,
          summary: approvalSummary(toolName, args),
          risk: tool.risk ?? 'write',
          argsPreview: toolArgsPreview(toolName, args),
        });
      } catch (error) {
        if (signal?.aborted) {
          await skipToolCalls(remainingOnAbort, 'Skipped: run cancelled.');
          throwIfAborted(signal);
        }
        if (error instanceof ApprovalDenied) {
          return completeAsDenied(call);
        }
        throw error;
      }
    }

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
      const result = await withTimeout(
        tool.execute(args, toolCtx),
        toolName === 'ask_user' || toolName === 'offer_choice'
          ? 0
          : limits.toolTimeoutMs,
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
        resultPreview: preview(result, 200),
      });
      await appendDurable({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result,
      });
      return 'ok';
    } catch (error) {
      if (signal?.aborted) {
        await skipToolCalls(remainingOnAbort, 'Skipped: run cancelled.');
        throwIfAborted(signal);
      }
      if (error instanceof ApprovalDenied) {
        return completeAsDenied(call);
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
  ): Promise<'ok' | 'deferred'> {
    if (
      batch.length === 1 ||
      batch.some(
        (call) =>
          LOOP_APPROVAL_TOOLS.has(call.toolName) ||
          call.toolName === 'offer_choice',
      )
    ) {
      for (let i = 0; i < batch.length; i++) {
        const call = batch[i];
        if (!call) continue;
        const outcome = await executeReadyCall(call, [
          ...batch.slice(i).map((item) => item.toolCall),
          ...remainingAfter,
        ]);
        if (outcome === 'deferred') return 'deferred';
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
          const result = await withTimeout(
            call.tool.execute(call.args, toolCtx),
            call.toolName === 'ask_user' || call.toolName === 'offer_choice'
              ? 0
              : limits.toolTimeoutMs,
            signal,
          );
          return { call, ok: true as const, result, durationMs: Date.now() - started };
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
          resultPreview: preview(item.result, 200),
        });
        await appendDurable({
          role: 'tool',
          tool_call_id: call.toolCall.id,
          content: item.result,
        });
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

      if (item.error instanceof ApprovalDenied) {
        await completeAsDenied(call);
        continue;
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
    return 'ok';
  }

  /** Fresh message lifecycle for limit finalization (never reuse the tool-turn id). */
  async function finalizeAnswer(): Promise<{
    content: string;
    usage?: TokenUsage;
  }> {
    const finalMessageId = randomUUID();
    const onTextDelta = config.streaming
      ? (delta: string) => {
          emit?.({
            type: 'assistant.delta',
            runId,
            messageId: finalMessageId,
            delta,
          });
        }
      : undefined;

    if (config.streaming) {
      emit?.({ type: 'assistant.started', runId, messageId: finalMessageId });
    }

    const turn = await finalizeWithoutTools(
      modelCall,
      config.model,
      messages,
      onTextDelta,
      signal,
    );
    const content = turn.content ?? '';

    await appendDurable({
      role: 'assistant',
      content,
    });

    emit?.({
      type: 'assistant.completed',
      runId,
      messageId: finalMessageId,
      content,
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
    });
    return {
      runId,
      content: final.content,
      iterations,
      toolCalls: totalToolCalls,
      status: 'incomplete',
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
    streaming: config.streaming,
    model: config.model,
    ...(config.estimatedPromptTokens !== undefined
      ? { estimatedPromptTokens: config.estimatedPromptTokens }
      : {}),
    ...(config.contextReport ? { contextReport: config.contextReport } : {}),
  });

  try {
    while (iterations < limits.maxIterations) {
      throwIfAborted(signal);
      iterations++;

      trace({ type: 'llm_request', runId, iteration: iterations });
      emit?.({ type: 'turn.started', runId, iteration: iterations });

      const messageId = randomUUID();
      const onTextDelta = config.streaming
        ? (delta: string) => {
            emit?.({
              type: 'assistant.delta',
              runId,
              messageId,
              delta,
            });
          }
        : undefined;

      if (config.streaming) {
        emit?.({ type: 'assistant.started', runId, messageId });
      }

      const turn = await modelCall(
        config.model,
        messages,
        tools,
        onTextDelta,
        signal,
      );
      throwIfAborted(signal);

      trace({
        type: 'llm_response',
        runId,
        iteration: iterations,
        finishReason: turn.finishReason,
        hasToolCalls: Boolean(turn.toolCalls.length),
        contentPreview: turn.content ? preview(turn.content) : undefined,
      });

      if (turn.toolCalls.length > 0) {
        await appendDurable({
          role: 'assistant',
          content: turn.content || null,
          tool_calls: turn.toolCalls,
        });

        // Tool turns end like any other: the ledger row is durable, so the
        // client can settle this assistant message before tools run.
        emit?.({
          type: 'assistant.completed',
          runId,
          messageId,
          content: turn.content,
        });

        let index = 0;
        while (index < turn.toolCalls.length) {
          // The assistant tool_calls row above is already durable. On abort,
          // every remaining call still needs a tool row or ledger replay breaks.
          if (signal?.aborted) {
            await skipToolCalls(
              turn.toolCalls.slice(index),
              'Skipped: run cancelled.',
            );
            throwIfAborted(signal);
          }

          const toolCall = turn.toolCalls[index];
          if (!toolCall || toolCall.type !== 'function') {
            index += 1;
            continue;
          }

          const admitted = await admitToolCall(toolCall);
          if (admitted.kind === 'halt') {
            return finishHalt(admitted, index, turn.toolCalls);
          }
          if (admitted.kind === 'filled') {
            index += 1;
            continue;
          }

          if (isParallelSafeTool(admitted.call.tool)) {
            const batch = [admitted.call];
            let next = index + 1;
            while (next < turn.toolCalls.length) {
              const upcoming = turn.toolCalls[next];
              if (!upcoming || upcoming.type !== 'function') break;
              const upcomingTool = tools.byName.get(upcoming.function.name);
              if (!isParallelSafeTool(upcomingTool)) break;
              if (posture === 'ask' && isAskStrippedTool(upcoming.function.name)) {
                break;
              }
              try {
                JSON.parse(upcoming.function.arguments);
              } catch {
                break;
              }
              const nextAdmitted = await admitToolCall(upcoming);
              if (nextAdmitted.kind === 'halt') {
                if ((await executeReadyBatch(batch, [])) === 'deferred') {
                  return finishChoiceSkipped();
                }
                return finishHalt(nextAdmitted, next, turn.toolCalls);
              }
              if (nextAdmitted.kind === 'filled') {
                if (
                  (await executeReadyBatch(
                    batch,
                    turn.toolCalls.slice(next + 1),
                  )) === 'deferred'
                ) {
                  return finishChoiceSkipped();
                }
                index = next + 1;
                batch.length = 0;
                break;
              }
              batch.push(nextAdmitted.call);
              next += 1;
            }
            if (batch.length > 0) {
              if (
                (await executeReadyBatch(
                  batch,
                  turn.toolCalls.slice(next),
                )) === 'deferred'
              ) {
                return finishChoiceSkipped();
              }
              index = next;
            }
            continue;
          }

          if (
            (await executeReadyCall(
              admitted.call,
              turn.toolCalls.slice(index),
            )) === 'deferred'
          ) {
            return finishChoiceSkipped();
          }
          index += 1;
        }

        stubLiveToolResults(messages, contextBudget);
        emitTurnCompleted(iterations, turn.usage);
        continue;
      }

      // No tool calls — this is the final assistant response.
      await appendDurable({
        role: 'assistant',
        content: turn.content ?? '',
      });

      emit?.({
        type: 'assistant.completed',
        runId,
        messageId,
        content: turn.content,
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
          const reason = 'Open plan todos remain';
          trace({
            type: 'limit',
            runId,
            iteration: iterations,
            reason,
          });
          emit?.({
            type: 'limit.hit',
            runId,
            reason,
          });
          emitTurnCompleted(iterations, turn.usage);
          emit?.({
            type: 'run.completed',
            runId,
            iterations,
            toolCalls: totalToolCalls,
            incomplete: true,
          });
          return {
            runId,
            content: result,
            iterations,
            toolCalls: totalToolCalls,
            status: 'incomplete',
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

      trace({
        type: 'limit',
        runId,
        iteration: iterations,
        reason: `unexpected finish reason: ${turn.finishReason}`,
      });
      emit?.({
        type: 'limit.hit',
        runId,
        reason: `unexpected finish reason: ${turn.finishReason}`,
      });
      emitTurnCompleted(iterations, turn.usage);
      emit?.({
        type: 'run.completed',
        runId,
        iterations,
        toolCalls: totalToolCalls,
        incomplete: true,
      });

      return {
        runId,
        content: turn.content ?? '',
        iterations,
        toolCalls: totalToolCalls,
        status: 'incomplete',
      };
    }

    // Max iterations exceeded — finalize without tools.
    trace({
      type: 'limit',
      runId,
      iteration: iterations,
      reason: `max iterations exceeded (${limits.maxIterations})`,
    });
    emit?.({
      type: 'limit.hit',
      runId,
      reason: `max iterations exceeded (${limits.maxIterations})`,
    });

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
