import {
  isResumableStop,
  limitCodeOf,
  RUN_CANCELLED_REASON,
  RUN_INTERRUPTED_REASON,
} from '@agent/agent-models';

/** Human sentence for each limit code; detail stays in the title tooltip. */
const LIMIT_LABELS: Record<string, string> = {
  'limit.repeat': 'The assistant kept repeating itself, so the run stopped.',
  'limit.tools': 'Tool budget reached.',
  'limit.read_storm': 'Too many reads without progress, so the run stopped.',
  'limit.terminal': 'The run hit a terminal limit.',
  'limit.unknown': 'The run stopped for an unknown reason.',
  'limit.outcome': 'The run stopped without a clear outcome.',
  'limit.iterations': 'Step limit reached.',
  'limit.plan': 'The plan gate stopped this run.',
  'limit.finish': 'The run finished its plan.',
  'limit.tokens': 'Token budget reached.',
  'limit.wall': 'Time limit reached.',
  'limit.research': 'Research budget reached.',
  'limit.capacity':
    'Your Ollama account ran low — the run paused, nothing was lost.',
};

/**
 * Turn a stop reason into a sentence the user can act on. Resumable stops
 * append the Continue hint; the raw reason stays available for the tooltip.
 */
export function stopReasonLabel(reason: string): string {
  if (reason === RUN_CANCELLED_REASON) return 'You stopped this run.';
  if (reason === RUN_INTERRUPTED_REASON) return reason;
  const code = limitCodeOf(reason);
  if (!code) return reason;
  const base = LIMIT_LABELS[code] ?? 'The run stopped early.';
  return isResumableStop(reason) ? `${base} Continue to keep going.` : base;
}

/** True when the stop reason is the user's own cancel, not a failure. */
export function isUserCancelled(reason: string): boolean {
  return reason === RUN_CANCELLED_REASON;
}
