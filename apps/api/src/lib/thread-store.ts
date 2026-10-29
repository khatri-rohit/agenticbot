import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  emptyThreadPlan,
  envelopeToChatMessage,
  envelopeToUiMessage,
  isThreadPlanEmpty,
  isWorkspaceKind,
  normalizeThreadKind,
  parseThreadPlan,
  parseSnapshot,
  sameWorkspaceRoot,
  selectPlanForRewind,
  parseThreadLastRun,
  type ChatMessage,
  type ContextWindowMode,
  type LedgerAppendMeta,
  type LedgerEnvelope,
  type LedgerRecord,
  type Message,
  type MessageAttachment,
  type Snapshot,
  type Thread,
  type ThreadKind,
  type ThreadLastRun,
  type ThreadPlan,
} from '@agent/agent-models';

const BLOB_INLINE_MAX = 8 * 1024;

export type AppendInput = {
  threadId: string;
  runId: string | null;
  record: LedgerRecord;
  attachments?: MessageAttachment[];
  meta?: LedgerAppendMeta;
  skills?: { selected: string[] };
};

export class ThreadStore {
  readonly home: string;
  private readonly db: DatabaseSync;
  private readonly writers = new Map<string, Promise<unknown>>();
  /** Per-thread seq cursor. Authoritative source is the ledger tail; the catalog caches it. */
  private readonly seqs = new Map<string, number>();

  constructor(home: string, db: DatabaseSync) {
    this.home = home;
    this.db = db;
  }

  close(): void {
    this.db.close();
  }

  listThreads(filter?: {
    kind?: ThreadKind;
    workspaceRoot?: string;
    includeSubagents?: boolean;
  }): Thread[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, model, pinned, created_at, updated_at, kind, workspace_root, parent_thread_id, parent_run_id, context_window_mode
         FROM threads
         ORDER BY pinned DESC, updated_at DESC`,
      )
      .all() as CatalogThreadRow[];
    const threads = rows.map(rowToThread);
    return threads.filter((thread) => {
      if (filter?.kind && (thread.kind ?? 'home') !== filter.kind) {
        return false;
      }
      if (
        filter?.workspaceRoot &&
        !sameWorkspaceRoot(thread.workspaceRoot, filter.workspaceRoot)
      ) {
        return false;
      }
      // Sub-agent threads are hidden from sidebar by default.
      if (
        !filter?.includeSubagents &&
        thread.parentThreadId !== undefined
      ) {
        return false;
      }
      return true;
    });
  }

  getThread(id: string): Thread | undefined {
    const row = this.db
      .prepare(
        `SELECT id, title, model, pinned, created_at, updated_at, kind, workspace_root, parent_thread_id, parent_run_id, context_window_mode
         FROM threads WHERE id = ?`,
      )
      .get(id) as CatalogThreadRow | undefined;
    return row ? rowToThread(row) : undefined;
  }

  async createThread(
    model: string,
    title = 'New Chat',
    options?: {
      kind?: ThreadKind;
      workspaceRoot?: string;
      parentThreadId?: string;
      parentRunId?: string;
      /** Sub-agent profile that owns this thread (resume must match it). */
      subagentProfile?: string;
    },
  ): Promise<Thread> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const dir = this.threadDir(id);
    const kind: ThreadKind = normalizeThreadKind(options?.kind);
    const workspaceRoot =
      isWorkspaceKind(kind) && options?.workspaceRoot
        ? options.workspaceRoot
        : null;
    await mkdir(path.join(dir, 'blobs'), { recursive: true });
    await writeFile(path.join(dir, 'ledger.jsonl'), '', { flag: 'wx' });

    this.db
      .prepare(
        `INSERT INTO threads (id, title, model, pinned, created_at, updated_at, last_seq, kind, workspace_root, parent_thread_id, parent_run_id, subagent_profile)
         VALUES (?, ?, ?, 0, ?, ?, 0, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        title,
        model,
        now,
        now,
        kind,
        workspaceRoot,
        options?.parentThreadId ?? null,
        options?.parentRunId ?? null,
        options?.subagentProfile ?? null,
      );

    return {
      id,
      title,
      model,
      createdAt: now,
      updatedAt: now,
      pinned: false,
      kind,
      ...(workspaceRoot ? { workspaceRoot } : {}),
      ...(options?.parentThreadId ? { parentThreadId: options.parentThreadId } : {}),
      ...(options?.parentRunId ? { parentRunId: options.parentRunId } : {}),
    };
  }

  updateThread(
    id: string,
    changes: {
      title?: string;
      model?: string;
      pinned?: boolean;
      kind?: ThreadKind;
      workspaceRoot?: string | null;
      contextWindowMode?: ContextWindowMode;
    },
  ): Thread | undefined {
    const current = this.getThread(id);
    if (!current) return undefined;
    if (changes.contextWindowMode !== undefined) {
      this.db
        .prepare(`UPDATE threads SET context_window_mode = ? WHERE id = ?`)
        .run(changes.contextWindowMode, id);
    }

    const title = changes.title ?? current.title;
    const model = changes.model ?? current.model;
    const pinned =
      changes.pinned !== undefined ? (changes.pinned ? 1 : 0) : current.pinned ? 1 : 0;
    const kind: ThreadKind = normalizeThreadKind(
      changes.kind ?? current.kind ?? 'home',
    );
    const workspaceRoot =
      changes.workspaceRoot === undefined
        ? (current.workspaceRoot ?? null)
        : changes.workspaceRoot;

    this.db
      .prepare(
        `UPDATE threads SET title = ?, model = ?, pinned = ?, kind = ?, workspace_root = ? WHERE id = ?`,
      )
      .run(title, model, pinned, kind, workspaceRoot, id);

    return this.getThread(id);
  }

  /** Profile recorded for a sub-agent thread, if any. */
  subagentProfile(id: string): string | undefined {
    const row = this.db
      .prepare(`SELECT subagent_profile FROM threads WHERE id = ?`)
      .get(id) as { subagent_profile?: string | null } | undefined;
    return row?.subagent_profile ?? undefined;
  }

  /**
   * Delete sub-agent threads of `parentThreadId` (all, or only those started
   * by `runIds`), recursively. Children never outlive the run that made them.
   */
  async deleteChildThreads(parentThreadId: string, runIds?: Set<string>): Promise<void> {
    const rows = this.db
      .prepare(`SELECT id, parent_run_id FROM threads WHERE parent_thread_id = ?`)
      .all(parentThreadId) as { id: string; parent_run_id?: string | null }[];
    for (const row of rows) {
      if (runIds && !(row.parent_run_id && runIds.has(row.parent_run_id))) continue;
      await this.deleteThread(row.id);
    }
  }

  async deleteThread(id: string): Promise<boolean> {
    if (!this.getThread(id)) return false;
    await this.deleteChildThreads(id);
    await rm(this.threadDir(id), { recursive: true, force: true });
    this.db.prepare(`DELETE FROM threads WHERE id = ?`).run(id);
    this.writers.delete(id);
    this.seqs.delete(id);
    return true;
  }

  append(input: AppendInput): Promise<LedgerEnvelope> {
    return this.serialize(input.threadId, () => this.appendUnlocked(input));
  }

  async readLedger(threadId: string, fromSeq = 0): Promise<LedgerEnvelope[]> {
    const { envelopes } = await this.loadLedger(threadId);
    return fromSeq > 0
      ? envelopes.filter((envelope) => envelope.seq >= fromSeq)
      : envelopes;
  }

  async readBlob(threadId: string, sha256: string): Promise<Buffer> {
    return readFile(path.join(this.threadDir(threadId), 'blobs', sha256));
  }

  rewind(threadId: string, keepThroughSeq: number): Promise<void> {
    return this.serialize(threadId, () =>
      this.rewindUnlocked(threadId, keepThroughSeq),
    );
  }

  async hydrateToolContent(
    threadId: string,
    envelope: LedgerEnvelope,
  ): Promise<string | undefined> {
    if (!envelope.contentBlob) return undefined;
    const buf = await this.readBlob(threadId, envelope.contentBlob);
    return buf.toString('utf8');
  }

  /** Inline blob bodies so assembleContext can stub from live content. */
  async hydrateEnvelopes(threadId: string): Promise<LedgerEnvelope[]> {
    const envelopes = await this.readLedger(threadId, 0);
    const hydrated: LedgerEnvelope[] = [];
    for (const envelope of envelopes) {
      const toolContent = await this.hydrateToolContent(threadId, envelope);
      if (!toolContent || envelope.record.role !== 'tool') {
        hydrated.push(envelope);
        continue;
      }
      hydrated.push({
        ...envelope,
        record: { ...envelope.record, content: toolContent },
      });
    }
    return hydrated;
  }

  async toChatMessages(threadId: string): Promise<ChatMessage[]> {
    const envelopes = await this.readLedger(threadId, 0);
    const messages: ChatMessage[] = [];
    for (const envelope of envelopes) {
      const toolContent = await this.hydrateToolContent(threadId, envelope);
      const message = toolContent
        ? envelopeToChatMessage(envelope, toolContent)
        : envelopeToChatMessage(envelope);
      if (message) messages.push(message);
    }
    return messages;
  }

  async toUiMessages(threadId: string): Promise<Message[]> {
    const envelopes = await this.readLedger(threadId, 0);
    const messages: Message[] = [];
    for (const envelope of envelopes) {
      const toolContent = await this.hydrateToolContent(threadId, envelope);
      const message = toolContent
        ? envelopeToUiMessage(envelope, toolContent)
        : envelopeToUiMessage(envelope);
      if (message) messages.push(message);
    }
    return messages;
  }

  lastUserSeq(envelopes: LedgerEnvelope[]): number | undefined {
    for (let i = envelopes.length - 1; i >= 0; i--) {
      if (envelopes[i].record.role === 'user') return envelopes[i].seq;
    }
    return undefined;
  }

  /**
   * Fold the seq cursor from the ledger tail (authoritative) into memory and
   * the catalog cache. Repairs a torn tail line — safe because callers hold
   * this thread's write queue.
   */
  private async ensureSeq(threadId: string): Promise<void> {
    if (this.seqs.has(threadId)) return;
    const { envelopes, torn } = await this.loadLedger(threadId);
    if (torn) await this.rewriteLedger(threadId, envelopes);
    const tail = envelopes.at(-1)?.seq ?? 0;
    this.seqs.set(threadId, tail);
    this.db
      .prepare(`UPDATE threads SET last_seq = ? WHERE id = ?`)
      .run(tail, threadId);
  }

  /**
   * Parse the ledger. A crash mid-append can tear the last line; reads skip
   * it and the append path repairs it under the per-thread write queue.
   */
  private async loadLedger(
    threadId: string,
  ): Promise<{ envelopes: LedgerEnvelope[]; torn: boolean }> {
    const raw = await readFile(this.ledgerPath(threadId), 'utf8').catch(
      () => '',
    );
    const envelopes: LedgerEnvelope[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        envelopes.push(JSON.parse(line) as LedgerEnvelope);
      } catch {
        return { envelopes, torn: true };
      }
    }
    return { envelopes, torn: false };
  }

  /** Replace the ledger file with exactly these envelopes (atomic tmp+rename). */
  private async rewriteLedger(
    threadId: string,
    envelopes: LedgerEnvelope[],
  ): Promise<void> {
    const dest = this.ledgerPath(threadId);
    const tmp = `${dest}.tmp`;
    const body = envelopes
      .map((envelope) => JSON.stringify(envelope))
      .join('\n');
    await writeFile(tmp, body.length > 0 ? `${body}\n` : '', 'utf8');
    await rename(tmp, dest);
  }

  private serialize<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.writers.get(threadId) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.writers.set(
      threadId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private async appendUnlocked(input: AppendInput): Promise<LedgerEnvelope> {
    if (!this.getThread(input.threadId)) {
      throw new Error(`Thread not found: ${input.threadId}`);
    }

    await this.ensureSeq(input.threadId);
    const seq = (this.seqs.get(input.threadId) ?? 0) + 1;

    let record = input.record;
    let contentBlob: string | undefined;

    if (record.role === 'tool' && record.content.length > BLOB_INLINE_MAX) {
      contentBlob = await this.putBlob(input.threadId, record.content);
      record = {
        ...record,
        content: `(full result in blob sha256:${contentBlob})`,
      };
    }

    const envelope: LedgerEnvelope = {
      v: 1,
      seq,
      ts: new Date().toISOString(),
      threadId: input.threadId,
      runId: input.runId,
      record,
      ...(contentBlob ? { contentBlob } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.meta?.durationMs != null
        ? { durationMs: input.meta.durationMs }
        : {}),
      ...(input.skills ? { skills: input.skills } : {}),
    };

    try {
      await appendLineDurable(
        this.ledgerPath(input.threadId),
        `${JSON.stringify(envelope)}\n`,
      );
    } catch (error) {
      // A failed append can leave a torn line; drop it so the next append
      // (or a restart) sees a clean tail. Rethrow after repair.
      const { envelopes } = await this.loadLedger(input.threadId);
      await this.rewriteLedger(input.threadId, envelopes);
      throw error;
    }
    this.seqs.set(input.threadId, seq);

    this.db
      .prepare(
        `UPDATE threads SET last_seq = ?, updated_at = ? WHERE id = ?`,
      )
      .run(envelope.seq, envelope.ts, input.threadId);

    return envelope;
  }

  private async rewindUnlocked(
    threadId: string,
    keepThroughSeq: number,
  ): Promise<void> {
    if (!this.getThread(threadId)) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    const all = (await this.loadLedger(threadId)).envelopes;
    const kept = all.filter((envelope) => envelope.seq <= keepThroughSeq);
    // Runs whose rows are discarded take their sub-agent threads with them.
    const keptRuns = new Set(kept.map((envelope) => envelope.runId).filter(Boolean));
    const droppedRuns = new Set(
      all
        .filter((envelope) => envelope.seq > keepThroughSeq && envelope.runId)
        .map((envelope) => envelope.runId as string)
        .filter((runId) => !keptRuns.has(runId)),
    );
    await this.rewriteLedger(threadId, kept);
    if (droppedRuns.size > 0) await this.deleteChildThreads(threadId, droppedRuns);
    const now = new Date().toISOString();
    const lastSeq = kept.at(-1)?.seq ?? 0;
    this.seqs.set(threadId, lastSeq);
    this.db
      .prepare(
        `UPDATE threads SET last_seq = ?, updated_at = ? WHERE id = ?`,
      )
      .run(lastSeq, now, threadId);
    await this.invalidateSnapshot(threadId, keepThroughSeq);
    await this.restorePlanAfterRewind(threadId, keepThroughSeq);
  }

  private async readJsonFile<T>(
    filePath: string,
    parse: (raw: unknown) => T,
    fallback: T,
  ): Promise<T> {
    try {
      const raw = await readFile(filePath, 'utf8');
      return parse(JSON.parse(raw));
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT' || error instanceof SyntaxError) return fallback;
      throw error;
    }
  }

  async readSnapshot(threadId: string): Promise<Snapshot | null> {
    return this.readJsonFile(this.snapshotPath(threadId), parseSnapshot, null);
  }

  async writeSnapshot(threadId: string, snapshot: Snapshot): Promise<void> {
    await writeFile(
      this.snapshotPath(threadId),
      `${JSON.stringify(snapshot, null, 2)}\n`,
      'utf8',
    );
  }

  async deleteSnapshot(threadId: string): Promise<void> {
    await rm(this.snapshotPath(threadId), { force: true });
  }

  async readLastRun(threadId: string): Promise<ThreadLastRun | null> {
    return this.readJsonFile(this.lastRunPath(threadId), parseThreadLastRun, null);
  }

  async writeLastRun(threadId: string, lastRun: ThreadLastRun): Promise<void> {
    await writeFile(
      this.lastRunPath(threadId),
      `${JSON.stringify(lastRun, null, 2)}\n`,
      'utf8',
    );
  }

  async readPlan(threadId: string): Promise<ThreadPlan> {
    return this.readJsonFile(
      this.planPath(threadId),
      (raw) => parseThreadPlan(raw, threadId),
      emptyThreadPlan(threadId),
    );
  }

  async writePlan(threadId: string, plan: ThreadPlan): Promise<ThreadPlan> {
    return this.serialize(threadId, () => this.writePlanUnlocked(threadId, plan));
  }

  private async writePlanUnlocked(
    threadId: string,
    plan: ThreadPlan,
  ): Promise<ThreadPlan> {
    await this.ensureSeq(threadId);
    // Next ledger seq is the tool row that will be appended after execute.
    const ledgerSeq = (this.seqs.get(threadId) ?? 0) + 1;
    const next: ThreadPlan = {
      ...plan,
      threadId,
      updatedAt: new Date().toISOString(),
      ledgerSeq,
    };
    const revisions = await this.readPlanLog(threadId);
    if (revisions.length === 0) {
      const existing = await this.readPlan(threadId);
      if (!isThreadPlanEmpty(existing)) {
        revisions.push({
          ...existing,
          ledgerSeq: existing.ledgerSeq ?? 0,
        });
      }
    }
    revisions.push(next);
    const oldestLedgerSeq =
      (await this.loadLedger(threadId)).envelopes[0]?.seq ?? 0;
    const kept = revisions.filter(
      (revision) => (revision.ledgerSeq ?? 0) >= oldestLedgerSeq,
    );
    await this.writePlanFiles(threadId, next, kept);
    return next;
  }

  private async restorePlanAfterRewind(
    threadId: string,
    keepThroughSeq: number,
  ): Promise<void> {
    const revisions = await this.readPlanLog(threadId);
    if (revisions.length === 0) return;
    const restored = selectPlanForRewind(
      revisions,
      keepThroughSeq,
      threadId,
    );
    const kept = revisions.filter(
      (revision) => (revision.ledgerSeq ?? 0) <= keepThroughSeq,
    );
    await this.writePlanFiles(threadId, restored, kept);
  }

  private async readPlanLog(threadId: string): Promise<ThreadPlan[]> {
    return this.readJsonFile(
      this.planLogPath(threadId),
      (raw) => (Array.isArray(raw) ? raw.map((item) => parseThreadPlan(item, threadId)) : []),
      [],
    );
  }

  private async writePlanFiles(
    threadId: string,
    plan: ThreadPlan,
    revisions: ThreadPlan[],
  ): Promise<void> {
    await writeFile(
      this.planPath(threadId),
      `${JSON.stringify(plan, null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      this.planLogPath(threadId),
      `${JSON.stringify(revisions, null, 2)}\n`,
      'utf8',
    );
  }

  private async invalidateSnapshot(
    threadId: string,
    keepThroughSeq: number,
  ): Promise<void> {
    const snapshot = await this.readSnapshot(threadId);
    if (!snapshot) return;
    if (keepThroughSeq < snapshot.throughSeq) {
      await this.deleteSnapshot(threadId);
    }
  }

  async putBlob(threadId: string, text: string): Promise<string> {
    const bytes = Buffer.from(text, 'utf8');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const dest = path.join(this.threadDir(threadId), 'blobs', sha);
    await mkdir(path.dirname(dest), { recursive: true });
    try {
      await writeFile(dest, bytes, { flag: 'wx' });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw error;
    }
    return sha;
  }

  /** Per-thread JSONL traces (one file per run), read by the future eval app. */
  traceDir(threadId: string): string {
    return path.join(this.threadDir(threadId), 'traces');
  }

  private threadDir(threadId: string): string {
    return path.join(this.home, 'sessions', threadId);
  }

  private ledgerPath(threadId: string): string {
    return path.join(this.threadDir(threadId), 'ledger.jsonl');
  }

  private snapshotPath(threadId: string): string {
    return path.join(this.threadDir(threadId), 'snapshot.json');
  }

  private planPath(threadId: string): string {
    return path.join(this.threadDir(threadId), 'plan.json');
  }

  private planLogPath(threadId: string): string {
    return path.join(this.threadDir(threadId), 'plan-log.json');
  }

  private lastRunPath(threadId: string): string {
    return path.join(this.threadDir(threadId), 'last-run.json');
  }
}

type CatalogThreadRow = {
  id: string;
  title: string;
  model: string;
  pinned: number;
  created_at: string;
  updated_at: string;
  kind?: string | null;
  workspace_root?: string | null;
  parent_thread_id?: string | null;
  parent_run_id?: string | null;
  context_window_mode?: string | null;
};

function rowToThread(row: CatalogThreadRow): Thread {
  const kind: ThreadKind = normalizeThreadKind(row.kind);
  return {
    id: row.id,
    title: row.title,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pinned: row.pinned === 1,
    kind,
    ...(row.workspace_root ? { workspaceRoot: row.workspace_root } : {}),
    ...(row.parent_thread_id ? { parentThreadId: row.parent_thread_id } : {}),
    ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
    ...(row.context_window_mode === 'model' || row.context_window_mode === 'default'
      ? { contextWindowMode: row.context_window_mode }
      : {}),
  };
}

function ensureColumn(
  db: DatabaseSync,
  table: string,
  name: string,
  ddl: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (cols.some((col) => col.name === name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

async function appendLineDurable(filePath: string, line: string): Promise<void> {
  const fh = await open(filePath, 'a');
  try {
    await fh.write(line);
    await fh.datasync();
  } finally {
    await fh.close();
  }
}

export async function openThreadStore(home: string): Promise<ThreadStore> {
  await mkdir(path.join(home, 'sessions'), { recursive: true });
  const db = new DatabaseSync(path.join(home, 'catalog.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Chat',
      model TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seq INTEGER NOT NULL DEFAULT 0
    );
  `);
  ensureColumn(db, 'threads', 'kind', `kind TEXT NOT NULL DEFAULT 'home'`);
  ensureColumn(db, 'threads', 'workspace_root', `workspace_root TEXT`);
  ensureColumn(db, 'threads', 'parent_thread_id', `parent_thread_id TEXT`);
  ensureColumn(db, 'threads', 'parent_run_id', `parent_run_id TEXT`);
  ensureColumn(db, 'threads', 'context_window_mode', `context_window_mode TEXT`);
  ensureColumn(db, 'threads', 'subagent_profile', `subagent_profile TEXT`);
  db.exec(`
    UPDATE threads SET kind = 'home' WHERE kind IN ('research', '');
    UPDATE threads SET kind = 'workspace' WHERE kind = 'coding';
  `);
  return new ThreadStore(home, db);
}
