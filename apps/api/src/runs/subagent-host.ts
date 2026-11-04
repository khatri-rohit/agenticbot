import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import {
  WORKSPACE_MODE,
  envelopeToChatMessage,
  type OllamaEndpoint,
  type ThinkingValue,
} from '@agent/agent-models';
import {
  createStreamModelCall,
  getOllamaModelConfig,
  loadWorkspaceRules,
  resolveProfileThinking,
  type SubagentHost,
} from '@agent/agent-core';

import { capacityState } from '../models/capacity';
import { modelRolesFor, resolveCallOptions, resolveContextBudget } from '../models/model-runtime';
import type { ThreadStore } from '../threads/thread-store';
import { threadTraceSink } from '../platform/trace-sink.js';

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
        subagentProfile: input.profile,
      });
      return { id: thread.id };
    },
    childInfo(threadId) {
      const thread = store.getThread(threadId);
      if (!thread) return undefined;
      const profile = store.subagentProfile(threadId);
      return {
        ...(thread.parentThreadId ? { parentThreadId: thread.parentThreadId } : {}),
        ...(profile ? { profile } : {}),
      };
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
    readBlob: (threadId, sha256, offset, length) =>
      store.readBlobText(threadId, sha256, offset, length),
    writeLastRun: (threadId, lastRun) => store.writeLastRun(threadId, lastRun),
    // Behind weekly pace, review/advisor run on the main model instead of the
    // strong one; explore already uses fast.
    modelFor: (role, parentModel) =>
      modelRolesFor(parentModel)[
        role === 'strong' && endpoint === 'cloud' && capacityState() === 'conserve'
          ? 'main'
          : role
      ],
    async modelCall(model, preference) {
      // The profile says off / default / max; the child model's own values
      // say what that means (off only if it offers off, max = its top level).
      let thinking: ThinkingValue | undefined;
      try {
        thinking = resolveProfileThinking(await getOllamaModelConfig(model, endpoint), preference);
      } catch {
        thinking = undefined;
      }
      return createStreamModelCall(
        await resolveCallOptions(model, thinking, endpoint, WORKSPACE_MODE.temperature),
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
    trace: (threadId) => threadTraceSink(store, threadId),
  };
}
