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
  sameWorkspaceRoot,
  selectPlanForRewind,
  type ChatMessage,
  type LedgerEnvelope,
  type LedgerRecord,
  type Message,
  type MessageAttachment,
  type Snapshot,
  type Thread,
  type ThreadKind,
  type ThreadPlan,
} from '@org/agent-models';

const BLOB_INLINE_MAX = 8 * 1024;

export type AppendInput = {
  threadId: string;
  runId: string | null;
  record: LedgerRecord;
  attachments?: MessageAttachment[];
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
  }): Thread[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, model, pinned, created_at, updated_at, kind, workspace_root
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
      return true;
    });
  }

  getThread(id: string): Thread | undefined {
    const row = this.db
      .prepare(
        `SELECT id, title, model, pinned, created_at, updated_at, kind, workspace_root
         FROM threads WHERE id = ?`,
      )
      .get(id) as CatalogThreadRow | undefined;
    return row ? rowToThread(row) : undefined;
  }

  async createThread(
    model: string,
    title = 'New Chat',
    options?: { kind?: ThreadKind; workspaceRoot?: string },
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
        `INSERT INTO threads (id, title, model, pinned, created_at, updated_at, last_seq, kind, workspace_root)
         VALUES (?, ?, ?, 0, ?, ?, 0, ?, ?)`,
      )
      .run(id, title, model, now, now, kind, workspaceRoot);

    return {
      id,
      title,
      model,
      createdAt: now,
      updatedAt: now,
      pinned: false,
      kind,
      ...(workspaceRoot ? { workspaceRoot } : {}),
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
    },
  ): Thread | undefined {
    const current = this.getThread(id);
    if (!current) return undefined;

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

  async deleteThread(id: string): Promise<boolean> {
    if (!this.getThread(id)) return false;
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
    const kept = (await this.loadLedger(threadId)).envelopes.filter(
      (envelope) => envelope.seq <= keepThroughSeq,
    );
    await this.rewriteLedger(threadId, kept);
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

  async readSnapshot(threadId: string): Promise<Snapshot | null> {
    try {
      const raw = await readFile(this.snapshotPath(threadId), 'utf8');
      return JSON.parse(raw) as Snapshot;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') return null;
      if (error instanceof SyntaxError) return null;
      throw error;
    }
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

  async readPlan(threadId: string): Promise<ThreadPlan> {
    try {
      const raw = await readFile(this.planPath(threadId), 'utf8');
      return parseThreadPlan(JSON.parse(raw), threadId);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') return emptyThreadPlan(threadId);
      if (error instanceof SyntaxError) return emptyThreadPlan(threadId);
      throw error;
    }
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
    try {
      const raw = await readFile(this.planLogPath(threadId), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((item) => parseThreadPlan(item, threadId));
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') return [];
      if (error instanceof SyntaxError) return [];
      throw error;
    }
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

  private async putBlob(threadId: string, text: string): Promise<string> {
    const bytes = Buffer.from(text, 'utf8');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const dest = path.join(this.threadDir(threadId), 'blobs', sha);
    try {
      await writeFile(dest, bytes, { flag: 'wx' });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw error;
    }
    return sha;
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
  db.exec(`
    UPDATE threads SET kind = 'home' WHERE kind IN ('research', '');
    UPDATE threads SET kind = 'workspace' WHERE kind = 'coding';
  `);
  return new ThreadStore(home, db);
}
