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
  envelopeToChatMessage,
  envelopeToUiMessage,
  type ChatMessage,
  type LedgerEnvelope,
  type LedgerRecord,
  type Message,
  type MessageAttachment,
  type Thread,
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

  listThreads(): Thread[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, model, pinned, created_at, updated_at
         FROM threads
         ORDER BY pinned DESC, updated_at DESC`,
      )
      .all() as CatalogThreadRow[];
    return rows.map(rowToThread);
  }

  getThread(id: string): Thread | undefined {
    const row = this.db
      .prepare(
        `SELECT id, title, model, pinned, created_at, updated_at
         FROM threads WHERE id = ?`,
      )
      .get(id) as CatalogThreadRow | undefined;
    return row ? rowToThread(row) : undefined;
  }

  async createThread(model: string, title = 'New Chat'): Promise<Thread> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const dir = this.threadDir(id);
    await mkdir(path.join(dir, 'blobs'), { recursive: true });
    await writeFile(path.join(dir, 'ledger.jsonl'), '', { flag: 'wx' });

    this.db
      .prepare(
        `INSERT INTO threads (id, title, model, pinned, created_at, updated_at, last_seq)
         VALUES (?, ?, ?, 0, ?, ?, 0)`,
      )
      .run(id, title, model, now, now);

    return {
      id,
      title,
      model,
      createdAt: now,
      updatedAt: now,
      pinned: false,
    };
  }

  updateThread(
    id: string,
    changes: { title?: string; model?: string; pinned?: boolean },
  ): Thread | undefined {
    const current = this.getThread(id);
    if (!current) return undefined;

    const title = changes.title ?? current.title;
    const model = changes.model ?? current.model;
    const pinned =
      changes.pinned !== undefined ? (changes.pinned ? 1 : 0) : current.pinned ? 1 : 0;

    this.db
      .prepare(
        `UPDATE threads SET title = ?, model = ?, pinned = ? WHERE id = ?`,
      )
      .run(title, model, pinned, id);

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
}

type CatalogThreadRow = {
  id: string;
  title: string;
  model: string;
  pinned: number;
  created_at: string;
  updated_at: string;
};

function rowToThread(row: CatalogThreadRow): Thread {
  return {
    id: row.id,
    title: row.title,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pinned: row.pinned === 1,
  };
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
  return new ThreadStore(home, db);
}
