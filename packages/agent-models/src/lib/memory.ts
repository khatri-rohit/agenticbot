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

/** Parse a memory op from persisted JSONL. Rejects malformed lines. */
export function parseMemoryOp(raw: unknown): MemoryOp | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.v !== 1) return null;
  if (typeof record.id !== 'string' || !record.id) return null;
  if (typeof record.ts !== 'string') return null;
  const target = parseMemoryTarget(record.target);
  if (!target) return null;
  if (record.action !== 'add' && record.action !== 'patch' && record.action !== 'remove') {
    return null;
  }
  if (typeof record.reason !== 'string') return null;
  if (
    !record.source ||
    typeof record.source !== 'object' ||
    Array.isArray(record.source)
  ) {
    return null;
  }
  const source = record.source as Record<string, unknown>;
  if (typeof source.threadId !== 'string') return null;
  if (typeof source.seq !== 'number') return null;
  if (record.by !== 'user' && record.by !== 'foreground' && record.by !== 'review') {
    return null;
  }
  if (
    record.evidence !== 'user-said' &&
    record.evidence !== 'observed' &&
    record.evidence !== 'external'
  ) {
    return null;
  }
  if (
    record.status !== 'applied' &&
    record.status !== 'staged' &&
    record.status !== 'rejected' &&
    record.status !== 'reverted'
  ) {
    return null;
  }
  return {
    v: 1,
    id: record.id,
    ts: record.ts,
    target,
    action: record.action,
    reason: record.reason,
    source: { threadId: source.threadId, seq: source.seq },
    by: record.by,
    evidence: record.evidence,
    status: record.status,
    ...(typeof record.oldText === 'string' ? { oldText: record.oldText } : {}),
    ...(typeof record.content === 'string' ? { content: record.content } : {}),
  };
}

function parseMemoryTarget(raw: unknown): MemoryTarget | null {
  if (raw === 'user' || raw === 'notes') return raw;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.project === 'string') return { project: record.project };
  if (typeof record.skill === 'string') return { skill: record.skill };
  return null;
}

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
