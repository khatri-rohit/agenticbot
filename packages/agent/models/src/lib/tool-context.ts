import type { ChoiceRequest, ChoiceResult } from './choice.js';

/**
 * Risk class for a tool. Host policy (approvals, cron profiles) keys off this.
 */
export type ToolRisk = 'read' | 'write' | 'exec' | 'network' | 'external';

/** Where the run originated — chat today; cron/channels later. */
export type ToolOrigin = 'chat' | 'cron' | 'channel' | 'eval';

/** Human decision on a paused tool. `approved_for_run` is a session grant. */
export type ApprovalDecision = 'approved' | 'denied' | 'approved_for_run';

export type ApprovalOption = {
  id: string;
  label: string;
};

export type ApprovalRequest = {
  toolName: string;
  summary: string;
  risk: ToolRisk;
  options?: ApprovalOption[];
  argsPreview?: unknown;
};

export type ApprovalResult = {
  optionId?: string;
};

/** Thrown when the human denies (not a tool crash). */
export class ApprovalDenied extends Error {
  override readonly name = 'ApprovalDenied';
  constructor(message = 'Denied by the user') {
    super(message);
  }
}

/**
 * Injected into every tool `execute(args, ctx)`.
 * Core never opens disk/network from this type — host fills the hooks.
 */
export type ToolContext = {
  runId: string;
  threadId: string;
  origin: ToolOrigin;
  /** Bound project/workspace root for file tools; unset for unbound chat. */
  workspaceRoot?: string;
  /** Aborted when the run is cancelled. Tools should honor it for I/O. */
  signal: AbortSignal;
  /** JIT read of a large blob by content hash (host-injected). */
  readBlob?: (
    sha256: string,
    offset?: number,
    length?: number,
  ) => Promise<string>;
  /**
   * Pause the run until the host resolves. Resolves with the decision payload;
   * rejects with ApprovalDenied or a cancel error.
   */
  approve?: (request: ApprovalRequest) => Promise<ApprovalResult>;
  /**
   * Pause for a mid-turn direction (checkboxes + optional text).
   * Resolves on Continue; rejects with ChoiceSkipped on Skip, or cancel.
   */
  offerChoice?: (request: ChoiceRequest) => Promise<ChoiceResult>;
};
