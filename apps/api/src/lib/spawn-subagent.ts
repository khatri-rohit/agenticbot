import { randomUUID } from 'node:crypto';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import type {
  AgentEventWithoutSeq,
  LedgerAppendMeta,
  LedgerRecord,
  RunPosture,
  SubagentSpec,
  SubagentResult,
} from '@agent/agent-models';
import {
  clampChatTitle,
  modeForKind,
  normalizeRunPosture,
} from '@agent/agent-models';
import {
  ALL_TOOLS,
  buildSystemPrompt,
  createPlanTools,
  createToolRegistry,
  formatSkillBodies,
  getSubagentProfile,
  loadWorkspaceRules,
  RunManager,
  DIGEST_MAX_CHARS,
  MAX_SUBAGENT_DEPTH,
  type ModelCallFn,
  type ToolRegistry,
} from '@agent/agent-core';

import type { ThreadStore } from './thread-store';

/**
 * Factory for the spawnSubagent closure. The host (API route) builds one
 * of these per parent run and passes it to runManager.start. The closure
 * creates a child thread, assembles the child's context, starts a child
 * run, emits subrun markers on the parent stream, and returns a bounded
 * digest.
 *
 * The closure NEVER throws — all errors become error SubagentResult (EC5).
 */
export function createSpawnSubagent(deps: {
  parentRunId: string;
  parentThreadId: string;
  parentPosture: RunPosture;
  depth: number;
  workspaceRoot?: string;
  endpoint: string;
  modelCall: ModelCallFn;
  runManager: RunManager;
  store: ThreadStore;
  emit?: (event: AgentEventWithoutSeq) => void;
  parentSignal?: AbortSignal;
}): (spec: SubagentSpec) => Promise<SubagentResult> {
  return async (spec: SubagentSpec): Promise<SubagentResult> => {
    const subRunId = randomUUID();

    // EC1: parent already aborted before spawn — don't create child thread.
    if (deps.parentSignal?.aborted) {
      return {
        subRunId,
        status: 'cancelled',
        summary: 'Parent cancelled before spawn.',
        iterations: 0,
        toolCalls: 0,
        limitReason: 'Run cancelled',
      };
    }

    try {
      const profile = getSubagentProfile(spec.profile);
      if (!profile) {
        return {
          subRunId,
          status: 'error',
          summary: `Unknown profile "${spec.profile}".`,
          iterations: 0,
          toolCalls: 0,
        };
      }

      // Posture narrowing: ask parent → ask child only.
      const childPosture: RunPosture =
        deps.parentPosture === 'ask'
          ? 'ask'
          : normalizeRunPosture(spec.posture ?? profile.posture);

      // Depth check.
      if (deps.depth >= MAX_SUBAGENT_DEPTH) {
        return {
          subRunId,
          status: 'error',
          summary: 'Agent depth limit reached. Solve the task yourself.',
          iterations: 0,
          toolCalls: 0,
        };
      }

      // Create child thread (D6: title from task).
      const childThread = await deps.store.createThread(
        profile.model,
        clampChatTitle(spec.task),
        {
          kind: 'workspace',
          ...(deps.workspaceRoot ? { workspaceRoot: deps.workspaceRoot } : {}),
          parentThreadId: deps.parentThreadId,
          parentRunId: deps.parentRunId,
        },
      );

      // Build child tool registry — profile tools + plan tools, posture-stripped.
      const planTools = createPlanTools({
        read: () => deps.store.readPlan(childThread.id),
        write: async (next) => {
          return deps.store.writePlan(childThread.id, next);
        },
      });
      const childTools: ToolRegistry = createToolRegistry(
        [...ALL_TOOLS, ...planTools],
        spec.tools ?? profile.tools,
        childPosture,
      );

      // Assemble child system prompt (D5, D-Identity).
      const basePrompt = buildSystemPrompt(
        childTools,
        'workspace',
        childPosture,
      );

      // Load AGENTS.md for the workspace.
      let agentsMd = '';
      if (deps.workspaceRoot) {
        try {
          const rules = await loadWorkspaceRules(deps.workspaceRoot);
          agentsMd = rules.agentsMd ?? '';
        } catch {
          // Workspace rules unavailable — proceed without.
        }
      }

      // Pre-load skill bodies into the system prompt (D5).
      const skillBodies = formatSkillBodies(profile.skills);

      // Assemble the full system message.
      const systemContent = [
        basePrompt,
        agentsMd ? `\n# Project rules (AGENTS.md)\n${agentsMd}` : '',
        `\n${profile.promptSection}`,
        skillBodies ? `\n${skillBodies}` : '',
      ].join('');

      // Assemble user message: task + focus files.
      const userContent = spec.focusFiles?.length
        ? `${spec.task}\n\nFocus files:\n${spec.focusFiles.map((f) => `- ${f}`).join('\n')}`
        : spec.task;

      const messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: systemContent },
        { role: 'user', content: userContent },
      ];

      // Default workspace limits (D-Limits: no carving).
      const mode = modeForKind('workspace');

      // Chained abort: parent cancel → runManager.cancel(childRunId).
      // RunManager owns its own AbortController; we cancel by runId.
      let childRunId: string | undefined;
      if (deps.parentSignal) {
        if (deps.parentSignal.aborted) {
          // EC1 re-check after async work — don't start the child at all.
          // (The early return at the top handles the pre-abort case, but
          // the signal may have fired during thread creation.)
        } else {
          deps.parentSignal.addEventListener('abort', () => {
            if (childRunId) deps.runManager.cancel(childRunId);
          });
        }
      }

      // Emit subrun.started on parent stream.
      deps.emit?.({
        type: 'subrun.started',
        runId: deps.parentRunId,
        subRunId,
        parentRunId: deps.parentRunId,
        subThreadId: childThread.id,
        profile: spec.profile,
        task: spec.task,
      });

      // Start child run.
      let childResult: { iterations: number; toolCalls: number; status: string; content: string; limitReason?: string } | undefined;

      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };

        childRunId = deps.runManager.start({
          threadId: childThread.id,
          model: profile.model,
          mode: mode.name,
          posture: childPosture,
          messages,
          tools: childTools,
          modelCall: deps.modelCall,
          limits: mode.limits,
          workspaceRoot: deps.workspaceRoot,
          putBlob: (text) => deps.store.putBlob(childThread.id, text),
          readBlob: async (sha256, offset, length) => {
            const buf = await deps.store.readBlob(childThread.id, sha256);
            const text = buf.toString('utf8');
            if (offset === undefined && length === undefined) return text;
            const start = offset ?? 0;
            return text.slice(start, length === undefined ? undefined : start + length);
          },
          // Child can delegate to depth 2 (MAX_SUBAGENT_DEPTH=2).
          // The child's delegate tool will check depth >= 2 and refuse.
          spawnSubagent: createSpawnSubagent({
            parentRunId: subRunId,
            parentThreadId: childThread.id,
            parentPosture: childPosture,
            depth: deps.depth + 1,
            workspaceRoot: deps.workspaceRoot,
            endpoint: deps.endpoint,
            modelCall: deps.modelCall,
            runManager: deps.runManager,
            store: deps.store,
            emit: deps.emit,
            parentSignal: deps.parentSignal,
          }),
          subagentDepth: deps.depth + 1,
          onMessage: async (record: LedgerRecord, meta?: LedgerAppendMeta) => {
            if (record.role === 'system') return;
            await deps.store.append({
              threadId: childThread.id,
              runId: subRunId,
              record,
              ...(meta ? { meta: { ...meta, parentRunId: deps.parentRunId, subRunId } } : { meta: { parentRunId: deps.parentRunId, subRunId } }),
            });
          },
          onFinished: async (result) => {
            const isCancelled = deps.parentSignal?.aborted;
            const runStatus = isCancelled
              ? { status: 'error' as const, limitReason: 'Run cancelled' }
              : { status: result.status, limitReason: result.limitReason };

            childResult = {
              iterations: result.iterations,
              toolCalls: result.toolCalls,
              status: isCancelled ? 'cancelled' : result.status,
              content: result.content,
              limitReason: runStatus.limitReason,
            };

            try {
              await deps.store.writeLastRun(childThread.id, {
                runId: subRunId,
                status: runStatus.status,
                incomplete: result.status === 'incomplete',
                iterations: result.iterations,
                toolCalls: result.toolCalls,
                finishedAt: new Date().toISOString(),
                ...(runStatus.limitReason ? { limitReason: runStatus.limitReason } : {}),
              });
            } catch {
              // Best-effort — don't block settle on lastRun write failure.
            }

            setTimeout(() => deps.runManager.clear(subRunId), 1000);
            finish();
          },
        });

        // Safety: if parent aborts and onFinished somehow doesn't fire,
        // cancel the child run directly and resolve.
        if (deps.parentSignal) {
          deps.parentSignal.addEventListener('abort', () => {
            setTimeout(() => {
              if (childRunId) deps.runManager.cancel(childRunId);
              finish();
            }, 2000);
          });
        }
      });

      // Extract and cap digest (D3).
      const rawDigest = childResult?.content ?? '';
      let digest = rawDigest;
      if (digest.length > DIGEST_MAX_CHARS) {
        digest =
          digest.slice(0, DIGEST_MAX_CHARS) +
          '\n[Digest truncated. See sub-agent thread for full output.]';
      }

      const status = (childResult?.status ?? 'error') as SubagentResult['status'];
      const iterations = childResult?.iterations ?? 0;
      const toolCalls = childResult?.toolCalls ?? 0;
      const limitReason = childResult?.limitReason;

      // Emit subrun.settled on parent stream.
      deps.emit?.({
        type: 'subrun.settled',
        runId: deps.parentRunId,
        subRunId,
        parentRunId: deps.parentRunId,
        status,
        iterations,
        toolCalls,
        summary: digest,
        ...(limitReason ? { limitReason } : {}),
      });

      return {
        subRunId,
        status,
        summary: digest,
        iterations,
        toolCalls,
        ...(limitReason ? { limitReason } : {}),
      };
    } catch (error) {
      // EC2/EC5: never throw — return error result.
      const msg = error instanceof Error ? error.message : String(error);

      deps.emit?.({
        type: 'subrun.settled',
        runId: deps.parentRunId,
        subRunId,
        parentRunId: deps.parentRunId,
        status: 'error',
        iterations: 0,
        toolCalls: 0,
        summary: `Sub-agent failed: ${msg}`,
      });

      return {
        subRunId,
        status: 'error',
        summary: `Sub-agent failed: ${msg}`,
        iterations: 0,
        toolCalls: 0,
      };
    }
  };
}