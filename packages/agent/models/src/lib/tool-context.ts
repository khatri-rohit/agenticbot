/**
 * Risk class for a tool. Host policy (approvals, cron profiles) keys off this.
 */
export type ToolRisk = 'read' | 'write' | 'exec' | 'network' | 'external';

/** Where the run originated — chat today; cron/channels later. */
export type ToolOrigin = 'chat' | 'cron' | 'channel' | 'eval';

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
   * Request host approval before a privileged side effect.
   * Resolves when approved; rejects when denied or the run is cancelled.
   */
  approve?: (request: {
    toolName: string;
    summary: string;
    risk: ToolRisk;
  }) => Promise<void>;
};
