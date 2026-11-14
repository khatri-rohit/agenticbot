import type {
  LedgerEnvelope,
  MemoryTarget,
  ModeConfig,
  OllamaEndpoint,
  Thread,
  ThreadLastRun,
  ThreadPlan,
} from '@agent/agent-models';
import {
  MAX_THREAD_MENTIONS,
  isWorkspaceKind,
  modeForKind,
  normalizeRunPosture,
  normalizeThreadKind,
  parseHarnessFlags,
  threadMentions,
  type ContextWindowMode,
  type HarnessFlags,
  type RunPosture,
} from '@agent/agent-models';
import {
  assembleContext,
  createMemoryTool,
  createPlanTools,
  createRunToolset,
  createSessionSearchTool,
  loadWorkspaceRules,
  packMentionedThread,
  prepareCarriedRecord,
  getSkill,
  type MentionedThreadContext,
  type ToolRegistry,
} from '@agent/agent-core';

import { resolveContextBudget } from '../models/model-runtime';
import { getMemoryStore, getThreadStore, runManager } from '../platform/instances';
import type { ThreadStore } from '../threads/thread-store';

export function endpointFromLocal(local: boolean | undefined): OllamaEndpoint {
  return local === true ? 'local' : 'cloud';
}

async function loadMentionedThreads(
  store: ThreadStore,
  envelopes: LedgerEnvelope[],
  currentThreadId: string,
): Promise<MentionedThreadContext[]> {
  const lastUser = [...envelopes]
    .reverse()
    .find((envelope) => envelope.record.role === 'user');
  const mentions = threadMentions(lastUser?.attachments).slice(
    0,
    MAX_THREAD_MENTIONS,
  );
  const segments: MentionedThreadContext[] = [];
  const seen = new Set<string>();
  for (const mention of mentions) {
    if (mention.threadId === currentThreadId || seen.has(mention.threadId)) {
      continue;
    }
    seen.add(mention.threadId);
    const thread = store.getThread(mention.threadId);
    if (!thread) continue;
    const other = await store.hydrateEnvelopes(mention.threadId);
    const snapshot = await store.readSnapshot(mention.threadId);
    const sourceLabel = isWorkspaceKind(thread.kind)
      ? (thread.workspaceRoot ?? 'Workspace')
      : 'Home';
    segments.push({
      threadId: thread.id,
      title: thread.title || mention.title,
      sourceLabel,
      text: packMentionedThread({
        title: thread.title || mention.title,
        sourceLabel,
        envelopes: other,
        snapshot,
      }),
    });
  }
  return segments;
}

export type MemoryUpdatedPayload = {
  opId: string;
  target: MemoryTarget;
  action: 'add' | 'patch' | 'remove';
};

export type PlanUpdatedPayload = {
  plan: ThreadPlan;
};

export function lastUserEnvelope(
  envelopes: LedgerEnvelope[],
): LedgerEnvelope | undefined {
  for (let i = envelopes.length - 1; i >= 0; i--) {
    if (envelopes[i].record.role === 'user') return envelopes[i];
  }
  return undefined;
}

function skillNameList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
  return names;
}

export function resolveRequestedSkills(
  raw: unknown,
  stored?: string[],
): string[] {
  const names =
    skillNameList(
      raw && typeof raw === 'object'
        ? (raw as { requested?: unknown }).requested
        : undefined,
    ) ?? stored;
  if (!names) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const skill = getSkill(name);
    if (!skill) continue;
    const key = skill.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(skill.name);
  }
  return out;
}

export async function prepareRun(input: {
  threadId: string;
  thread?: Thread;
  webSearch?: boolean;
  posture?: RunPosture;
  lastUserSeq: number;
  envelopes: LedgerEnvelope[];
  model: string;
  endpoint?: OllamaEndpoint;
  skillNames?: string[];
  /** Overrides the thread's stored mode (estimate previews a change). */
  contextWindowMode?: ContextWindowMode;
  onMemoryUpdated?: (payload: MemoryUpdatedPayload) => void;
  onPlanUpdated?: (payload: PlanUpdatedPayload) => void;
}): Promise<{
  tools: ToolRegistry;
  messages: ReturnType<typeof assembleContext>['messages'];
  report: ReturnType<typeof assembleContext>['report'];
  mode: ModeConfig;
  posture: RunPosture;
  /** Resolved once here; the loop must run with the same switches the prompt was built with. */
  flags: HarnessFlags;
}> {
  const flags = parseHarnessFlags(process.env.AGENT_FLAGS);
  const memory = getMemoryStore();
  const kind = normalizeThreadKind(input.thread?.kind);
  const mode = modeForKind(kind);
  const workspace = isWorkspaceKind(kind);
  const workspaceRoot = workspace ? input.thread?.workspaceRoot : undefined;
  const files = await memory.read(workspaceRoot);
  const posture = workspace
    ? normalizeRunPosture(input.posture)
    : ('agent' as const);
  if (workspace && workspaceRoot) {
    const rules = await loadWorkspaceRules(workspaceRoot);
    files.agentsMd = rules.agentsMd;
    files.project = rules.project;
  }
  const store = await getThreadStore();
  const plan =
    input.threadId === 'draft' ? null : await store.readPlan(input.threadId);
  const planTools =
    input.threadId === 'draft'
      ? []
      : createPlanTools({
          read: () => store.readPlan(input.threadId),
          write: async (next) => {
            const saved = await store.writePlan(input.threadId, next);
            input.onPlanUpdated?.({ plan: saved });
            return saved;
          },
        });

  const tools = createRunToolset({
    mode,
    posture,
    webSearch: input.webSearch,
    hostTools: [
      ...planTools,
      createSessionSearchTool(async (query, limit) =>
        store.searchMessages(query, { excludeThreadId: input.threadId, limit }),
      ),
      createMemoryTool({
        read: () => memory.read(workspaceRoot),
        apply: async (op) => {
          const applied = await memory.apply(op, workspaceRoot);
          input.onMemoryUpdated?.({
            opId: applied.id,
            target: applied.target,
            action: applied.action,
          });
          return applied;
        },
        stage: (op) => memory.stage(op, workspaceRoot),
        source: () => ({
          threadId: input.threadId,
          seq: input.lastUserSeq,
        }),
      }),
    ],
  });

  const window = await resolveContextBudget(
    input.model,
    input.endpoint ?? 'cloud',
    input.contextWindowMode ?? input.thread?.contextWindowMode,
  );

  const snapshot =
    input.threadId === 'draft'
      ? null
      : await store.readSnapshot(input.threadId);

  const mentionedThreads = await loadMentionedThreads(
    store,
    input.envelopes,
    input.threadId,
  );

  // Findings earlier runs recorded (v2 phase 6): carried in the stable
  // prefix, bounded like the card's record, the rest behind a blob sha.
  const carriedRecord =
    input.threadId === 'draft'
      ? null
      : await prepareCarriedRecord({
          records: await store.readTaskRecords(input.threadId),
          envelopes: input.envelopes,
          tokens: window.budget.recordCardTokens,
          putBlob: (text) => store.putBlob(input.threadId, text),
        });

  const skillNames = input.skillNames ?? [];
  const lastRun =
    input.threadId === 'draft' ? null : await readSettledLastRun(store, input.threadId);
  const { messages, report } = assembleContext(
    {
      tools,
      memory: files,
      snapshot,
      envelopes: input.envelopes,
      mode: mode.name,
      posture,
      mentionedThreads,
      skillNames,
      ...(plan ? { plan } : {}),
      ...(lastRun ? { lastRun } : {}),
      ...(carriedRecord ? { carriedRecord } : {}),
      flags,
    },
    window.budget,
  );

  return {
    tools,
    messages,
    report: { ...report, windowSource: window.source },
    mode,
    posture,
    flags,
  };
}/**
 * The thread's last settled run. While a run is live, its lastRun is only the
 * "interrupted" marker written at start, so it is not reported.
 */
export async function readSettledLastRun(
  store: ThreadStore,
  threadId: string,
): Promise<ThreadLastRun | null> {
  const lastRun = await store.readLastRun(threadId);
  return lastRun && !runManager.isActive(lastRun.runId) ? lastRun : null;
}


