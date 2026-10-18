/**
 * One curated-memory mutation. MEMORY.md / USER.md / PROJECT.md are
 * materialized files plus an ops log (host-owned).
 */
export type MemoryTarget =
  | 'user'
  | 'notes'
  | { project: string }
  | { skill: string };

export type MemoryOp = {
  v: 1;
  id: string;
  ts: string;
  target: MemoryTarget;
  action: 'add' | 'patch' | 'remove';
  /** Unique span for patch/remove. Also the added text for add (for revert). */
  oldText?: string;
  content?: string;
  /** One line: why this is durable. */
  reason: string;
  source: { threadId: string; seq: number };
  by: 'user' | 'foreground' | 'review';
  evidence: 'user-said' | 'observed' | 'external';
  status: 'applied' | 'staged' | 'rejected' | 'reverted';
};

/** Files the gate and assembler read. Host loads these from disk. */
export type MemoryFiles = {
  user: string;
  notes: string;
  project?: string;
  agentsMd?: string;
};

export type MemoryCaps = {
  userChars: number;
  notesChars: number;
  projectChars: number;
};

/** ~500 / 1000 / 800 tokens at 4 chars/token. Overflow is an error, never a silent drop. */
export const DEFAULT_MEMORY_CAPS: MemoryCaps = {
  userChars: 2000,
  notesChars: 4000,
  projectChars: 3200,
};

/** Gate input — host assigns id/ts/status after the verdict. */
export type ProposedMemoryOp = Omit<MemoryOp, 'v' | 'id' | 'ts' | 'status'>;

export type MemoryGateVerdict = 'apply' | 'stage' | 'reject';

export type MemoryGateResult = {
  op: ProposedMemoryOp;
  verdict: MemoryGateVerdict;
  why: string;
};
