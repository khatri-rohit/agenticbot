import type {
  AgentEvent,
  ModeConfig,
  RunPosture,
  TraceEvent,
} from '@agent/agent-models';
import { planHasOpenWork } from '@agent/agent-models';
import {
  RunManager,
  assembleContext,
  createInMemoryPlanStore,
  createPlanTools,
  createRunToolset,
  loadWorkspaceRules,
  type AgentLimits,
  type ModelCallFn,
  type RunEnd,
} from '@agent/agent-core';

const runs = new RunManager();

/**
 * One run outside the API through the pieces the API uses: the mode's tool
 * set, context assembly, and RunManager (lifecycle, events, outcome). The
 * thread is the one query; plans live in memory and memory files are not
 * read or written, so local runs never touch the real agent home.
 */
export async function runLocally(input: {
  query: string;
  mode: ModeConfig;
  posture: RunPosture;
  model: string;
  modelCall: ModelCallFn;
  workspaceRoot?: string;
  limits?: AgentLimits;
  trace?: (event: TraceEvent) => void;
  onEvent?: (event: AgentEvent) => void;
}): Promise<RunEnd> {
  const { mode, posture, workspaceRoot } = input;
  const planStore = createInMemoryPlanStore('local');
  const tools = createRunToolset({
    mode,
    posture,
    hostTools: createPlanTools(planStore),
  });
  const rules = workspaceRoot
    ? await loadWorkspaceRules(workspaceRoot)
    : { agentsMd: '', project: '' };
  const { messages, report } = assembleContext({
    tools,
    memory: {
      user: '',
      notes: '',
      ...(rules.agentsMd ? { agentsMd: rules.agentsMd } : {}),
      ...(rules.project ? { project: rules.project } : {}),
    },
    snapshot: null,
    plan: await planStore.read(),
    envelopes: [
      {
        v: 1,
        seq: 1,
        ts: new Date().toISOString(),
        threadId: 'local',
        runId: null,
        record: { role: 'user', content: input.query },
      },
    ],
    mode: mode.name,
    posture,
  });

  const claimed = runs.claim(`local-${Date.now()}`);
  if (!claimed.ok) throw new Error('local run could not claim its thread');
  const { runId } = claimed.claim;
  claimed.claim.start({
    model: input.model,
    mode: mode.name,
    posture,
    messages,
    tools,
    modelCall: input.modelCall,
    limits: input.limits ?? mode.limits,
    estimatedPromptTokens: report.occupiedTokens,
    contextReport: report,
    contextBudget: report.budget,
    hasOpenPlanWork: async () => planHasOpenWork(await planStore.read()),
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(input.trace ? { trace: input.trace } : {}),
  });

  // Nobody is at the keyboard: take the first option of every choice. The
  // event is sent before the choice is registered, so answer a tick later.
  const onEvent = (event: AgentEvent) => {
    if (event.type === 'choice.requested') {
      const first = event.options[0];
      console.log(`[auto-choice] ${event.question} → ${first?.label ?? 'skip'}`);
      queueMicrotask(() =>
        runs.resolveChoice(
          runId,
          event.choiceId,
          first ? { optionIds: [first.id] } : { skipped: true },
        ),
      );
    }
    input.onEvent?.(event);
  };
  const subscription = runs.subscribe(runId, 0, onEvent);
  for (const event of subscription?.replay ?? []) onEvent(event);
  const end = await runs.wait(runId);
  subscription?.unsubscribe();
  return end;
}
