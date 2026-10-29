import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import {
  WORKSPACE_MODE,
  envelopeToChatMessage,
  type OllamaEndpoint,
} from '@agent/agent-models';
import {
  createStreamModelCall,
  loadWorkspaceRules,
  type SubagentHost,
} from '@agent/agent-core';

import { modelRolesFor, resolveCallOptions, resolveContextBudget } from './model-runtime';
import type { ThreadStore } from './thread-store';
import { createJsonlTraceSink } from './trace-sink.js';

/**
 * API side of the sub-agent contract: persistence on the ThreadStore and
 * per-model call options. Built per parent run because the endpoint
 * (cloud vs local) belongs to that run.
 */
export function createSubagentHost(deps: {
  store: ThreadStore;
  endpoint: OllamaEndpoint;
}): SubagentHost {
  const { store, endpoint } = deps;
  return {
    async createThread(input) {
      const thread = await store.createThread(input.model, input.title, {
        kind: 'workspace',
        ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
        parentThreadId: input.parentThreadId,
        parentRunId: input.parentRunId,
      });
      return { id: thread.id };
    },
    parentOf(threadId) {
      return store.getThread(threadId)?.parentThreadId;
    },
    async loadMessages(threadId) {
      const envelopes = await store.hydrateEnvelopes(threadId);
      const messages: ChatCompletionMessageParam[] = [];
      for (const envelope of envelopes) {
        const chat = envelopeToChatMessage(envelope);
        if (!chat || chat.role === 'system') continue;
        messages.push(chat as ChatCompletionMessageParam);
      }
      return messages;
    },
    async append(input) {
      await store.append({
        threadId: input.threadId,
        runId: input.runId,
        record: input.record,
        ...(input.meta ? { meta: input.meta } : {}),
      });
    },
    putBlob: (threadId, text) => store.putBlob(threadId, text),
    async readBlob(threadId, sha256, offset, length) {
      const text = (await store.readBlob(threadId, sha256)).toString('utf8');
      if (offset === undefined && length === undefined) return text;
      const start = offset ?? 0;
      return text.slice(start, length === undefined ? undefined : start + length);
    },
    writeLastRun: (threadId, lastRun) => store.writeLastRun(threadId, lastRun),
    modelFor: (role, parentModel) => modelRolesFor(parentModel)[role],
    async modelCall(model) {
      // Children never think: they search and report. Thinking stays a parent choice.
      return createStreamModelCall(
        await resolveCallOptions(model, false, endpoint, WORKSPACE_MODE.temperature),
      );
    },
    async contextBudget(model) {
      return (await resolveContextBudget(model, endpoint, 'default')).budget;
    },
    async agentsMd(workspaceRoot) {
      try {
        return (await loadWorkspaceRules(workspaceRoot)).agentsMd ?? '';
      } catch {
        return '';
      }
    },
    trace: (threadId) => createJsonlTraceSink(store.traceDir(threadId)),
  };
}
