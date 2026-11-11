import type { ContextReportLayer, ContextWindowSource } from './context.js';
import type { HarnessFlags } from './flags.js';
import type { RunUsage, TokenUsage } from './run.js';
import type { System1EffortTrace, System1RunReport } from './system1.js';
import type { ToolStage } from './tool-context.js';

/**
 * One message as sent to the model: its sha256 is the key of a blob holding
 * `JSON.stringify(message)` in the thread's blob store.
 */
export type TraceMessageRef = {
  role: string;
  sha: string;
  /** Length of the message's text content. */
  chars: number;
  /** Tool messages: the call they answer. */
  toolCallId?: string;
  /** Assistant messages: the calls they made. */
  toolCallIds?: string[];
};

/** Exactly what one model call was sent (recorded when the host turns recording on). */
export type TraceCallInput = {
  messages: TraceMessageRef[];
  /** Tool definitions offered; null when tools were off. */
  tools: { sha: string; names: string[] } | null;
};

/**
 * Bumped when a TraceEvent field changes meaning or is removed. Adding an
 * optional field does not bump it. Sinks stamp every line with `v`, so an
 * offline reader (eval / observability app) can parse old traces. The JSONL
 * sink also stamps `ts` and `seq` (per-run-file emit order); order by `seq`.
 */
export const TRACE_SCHEMA_VERSION = 2;

/**
 * Internal execution trace events (console / eval harness / JSONL sink).
 *
 * Distinct from AgentEvent, which is the product protocol for SSE and UI.
 * Both may be emitted during a run. TraceEvents are the observability surface
 * for offline replay and eval debugging — they never flow over SSE.
 */
export type TraceEvent =
  | {
      type: 'run_start';
      runId: string;
      model: string;
      threadId?: string;
      /** Set on sub-agent runs; the parent's runId. */
      parentRunId?: string;
      /** 0 for a user run, 1 for its sub-agents. */
      depth?: number;
      mode?: string;
      posture?: string;
      windowTokens?: number;
      windowSource?: ContextWindowSource;
      /** Prompt size of the first call, split by context layer. */
      occupiedTokens?: number;
      layers?: ContextReportLayer[];
      /** Harness switches this run used (absent on traces from before flags). */
      flags?: HarnessFlags;
    }
  | {
      /** The final answer claimed success with no command after the last edit; sent back once. */
      type: 'stop_check';
      runId: string;
      iteration: number;
    }
  | {
      /** A tool error or steering note raised the rest of the run one reasoning rung. */
      type: 'effort_escalated';
      runId: string;
      iteration: number;
      from: string;
      to: string;
      reason: 'tool_error' | 'steering';
    }
  | {
      type: 'llm_request';
      runId: string;
      iteration: number;
      /** Heuristic size of the prompt about to be sent. */
      estimatedPromptTokens?: number;
      /** reasoning_effort sent on this call, when set. */
      reasoningEffort?: string;
      /** A tools-off final call (limit handoff, deferred choice), not a new iteration. */
      final?: true;
      input?: TraceCallInput;
    }
  | {
      type: 'llm_response';
      runId: string;
      iteration: number;
      finishReason: string | null;
      hasToolCalls: boolean;
      contentPreview?: string;
      /** Provider-reported token counts for this iteration, when available. */
      usage?: TokenUsage;
      /** Model call + stream time. */
      durationMs?: number;
      /** Provider sent no usage; the run charged the local estimate. */
      usageEstimated?: boolean;
      final?: true;
      /** The assistant message returned, as a blob ref (recorded runs only). */
      output?: { sha: string };
    }
  | {
      type: 'tool_start';
      runId: string;
      iteration: number;
      toolName: string;
      /** The model's tool_call id: links start, complete/error, ledger row and evictions. */
      toolCallId?: string;
      /** The tool's scheduling class, as the loop ran it. */
      stage?: ToolStage;
      args: unknown;
    }
  | {
      type: 'tool_complete';
      runId: string;
      iteration: number;
      toolName: string;
      toolCallId?: string;
      durationMs: number;
      resultPreview: string;
      /** Full result length before any preview clipping. */
      resultChars?: number;
      /** From the tool's own classifier, when it has one (`Tool.classify`). */
      outcome?: 'ok' | 'error';
      exitCode?: number;
    }
  | {
      type: 'tool_error';
      runId: string;
      iteration: number;
      toolName: string;
      toolCallId?: string;
      error: string;
    }
  | {
      type: 'limit';
      runId: string;
      iteration: number;
      reason: string;
    }
  | {
      type: 'run_finish';
      runId: string;
      iterations: number;
      toolCalls: number;
      status?: string;
      limitReason?: string;
      usage?: RunUsage;
      durationMs?: number;
      /** The run was cancelled (its abort signal fired). */
      cancelled?: true;
    }
  | {
      type: 'memory_gate';
      runId: string;
      /** Loop iteration; omitted when a tool emits outside the loop closure. */
      iteration?: number;
      toolName: 'memory';
      target: 'user' | 'notes' | 'project' | 'skill';
      verdict: 'apply' | 'reject' | 'stage';
      why: string;
    }
  | {
      type: 'context_compacted';
      runId: string;
      threadId: string;
      throughSeq: number;
      briefPreview: string;
    }
  | {
      /** In-run eviction of old tool results into cards. */
      type: 'context_evicted';
      runId: string;
      iteration: number;
      evicted: number;
      beforeTokens: number;
      afterTokens: number;
      /** Tool calls whose results became eviction cards in this pass. */
      toolCallIds?: string[];
      /** `superseded`: a later result of the same read range or command replaced them. Absent = size-based eviction. */
      reason?: 'superseded';
    }
  | {
      /** In-run extractive compaction of older iterations of this turn. */
      type: 'context_compacted_inrun';
      runId: string;
      iteration: number;
      beforeTokens: number;
      afterTokens: number;
      /** Tool calls whose rows were folded into the recap. */
      toolCallIds?: string[];
    }
  | {
      type: 'skill_loaded';
      runId: string;
      iteration?: number;
      name: string;
      section?: string;
      tokens: number;
      source: 'model' | 'pick' | 'profile';
    }
  | {
      type: 'skill_evicted';
      runId: string;
      iteration: number;
      name: string;
      residentIterations: number;
    }
  | {
      /** In-run compaction cannot get under its low mark; stopped for this run. */
      type: 'context_prefix_heavy';
      runId: string;
      iteration: number;
      promptTokens: number;
    }
  | {
      type: 'budget_warning';
      runId: string;
      iteration: number;
      reason: string;
      promptTokens: number;
      limitPromptTokens?: number;
    }
  | {
      /** Prompt tokens spent since the last edit or sub-agent report passed the steer mark. */
      type: 'stall_nudge';
      runId: string;
      iteration: number;
      idleTokens: number;
      promptTokens: number;
      limitPromptTokens: number;
    }
  | {
      /** Parent web tool refused until progress (edit or sub-agent report). */
      type: 'research_gate';
      runId: string;
      iteration: number;
      toolName: string;
      idleTokens: number;
    }
  | {
      /** The loop appended a steering note to a tool result. */
      type: 'tool_note';
      runId: string;
      iteration: number;
      toolName: string;
      note: 'read_creep' | 'web_slices' | 'serial_reads';
      count: number;
    }
  | {
      /** One System 1 effort decision (shadow decisions land after the call). */
      type: 'system1_decision';
      runId: string;
      iteration: number;
      decision: System1EffortTrace;
    }
  | {
      /** End-of-run System 1 summary, written even when clean. */
      type: 'system1_report';
      runId: string;
      report: System1RunReport;
    };
