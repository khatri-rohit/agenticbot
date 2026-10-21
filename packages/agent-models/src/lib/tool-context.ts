import type { ChoiceRequest, ChoiceResult } from './choice.js';

/**
 * Risk class for a tool. Loop parallelization and host policy key off this.
 */
export type ToolRisk = 'read' | 'write' | 'exec' | 'network' | 'external';

/** Where the run originated — chat today; cron/channels later. */
export type ToolOrigin = 'chat' | 'cron' | 'channel' | 'eval';

/** Human decision on an ask_user pause. */
export type ApprovalDecision = 'approved' | 'denied';

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
  /** Persist full text; returns sha256. Host optional — loop keeps an in-run cache. */
  putBlob?: (text: string) => Promise<string>;
  /**
   * Pause for ask_user until the host resolves. Resolves with the chosen
   * option; rejects with ApprovalDenied or a cancel error.
   */
  approve?: (request: ApprovalRequest) => Promise<ApprovalResult>;
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
};
