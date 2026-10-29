import type { ChoiceRequest, ChoiceResult } from './choice.js';
import type { SubagentSpec, SubagentResult } from './subagent-types.js';
import type { TraceEvent } from './trace.js';

/**
 * Risk class for a tool. Loop parallelization and host policy key off this.
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
  /** Persist full text; returns sha256. Host optional — loop keeps an in-run cache. */
  putBlob?: (text: string) => Promise<string>;
  /**
   * Pause for a mid-turn direction (checkboxes + optional text).
   * Resolves on Continue; rejects with ChoiceSkipped on Skip, or cancel.
   */
  offerChoice?: (request: ChoiceRequest) => Promise<ChoiceResult>;
  /**
   * Record http(s) URLs this run may web_fetch (user-pasted or search hits).
   * Page body links are not trusted.
   */
  noteTrustedWebUrls?: (urls: string[]) => void;
  /** Register a fetched page in the run source index (url → sha, body cache). */
  noteWebSource?: (source: {
    sha256: string;
    url: string;
    title: string;
    content: string;
  }) => void;
  /** Resolve a previously fetched page by sha (run cache, then host readBlob). */
  getWebSource?: (sha256: string) => Promise<
    | { sha256: string; url: string; title: string; content: string }
    | undefined
  >;
  /** Resolve sha for a URL already fetched this run. */
  getWebSourceByUrl?: (url: string) => string | undefined;
  /**
   * Loop trace sink. Tools that run a core gate (e.g. memory) emit a
   * TraceEvent here so eval/offline replay sees the gate verdict without
   * reading the tool result string. Undefined when the host passes no trace.
   */
  trace?: (event: TraceEvent) => void;
  /**
   * Spawn a sub-agent. The loop binds this to the parent run (signal, budget,
   * capabilities, depth). Undefined where delegation is off (Home, children).
   */
  spawnSubagent?: (spec: SubagentSpec) => Promise<SubagentResult>;
  /**
   * End the run after this tool batch with `content` as the final answer.
   * Used by a sub-agent's `report` tool so the child does not pay for one
   * more model call just to say "done".
   */
  requestStop?: (content: string) => void;
};
