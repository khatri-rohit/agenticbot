/**
 * One curated-memory mutation. MEMORY.md / USER.md / PROJECT.md are
 * materialized views of an ops log of these records (host-owned in M2+).
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
  /** Unique span for patch/remove. */
  oldText?: string;
  content?: string;
  /** One line: why this is durable. */
  reason: string;
  source: { threadId: string; seq: number };
  by: 'user' | 'foreground' | 'review';
  evidence: 'user-said' | 'observed' | 'external';
  status: 'applied' | 'staged' | 'rejected' | 'reverted';
};
