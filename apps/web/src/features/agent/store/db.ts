import Dexie, { type Table } from 'dexie';
import type { Thread, Message, Run } from '@org/agent-models';

/**
 * Local-first IndexedDB schema via Dexie.
 * The browser owns ALL durable state. The server is stateless.
 */
export class AgentDB extends Dexie {
  threads!: Table<Thread, string>;
  messages!: Table<Message, string>;
  runs!: Table<Run, string>;

  constructor() {
    super('agenticbot');

    this.version(1).stores({
      // Primary key + indexes for querying
      threads: 'id, updatedAt',
      messages: 'id, threadId, createdAt, [threadId+createdAt]',
      runs: 'id, threadId, status, createdAt',
    });
  }
}

export const db = new AgentDB();

/* ---------- Thread operations ---------- */

export async function createThread(
  title: string,
  model: string,
): Promise<Thread> {
  const now = new Date().toISOString();
  const thread: Thread = {
    id: crypto.randomUUID(),
    title,
    model,
    createdAt: now,
    updatedAt: now,
  };
  await db.threads.add(thread);
  return thread;
}

export async function getThreads(): Promise<Thread[]> {
  return db.threads.orderBy('updatedAt').reverse().toArray();
}

export async function getThread(id: string): Promise<Thread | undefined> {
  return db.threads.get(id);
}

export async function updateThread(
  id: string,
  changes: Partial<Thread>,
): Promise<void> {
  await db.threads.update(id, {
    ...changes,
    updatedAt: new Date().toISOString(),
  });
}

export async function deleteThread(id: string): Promise<void> {
  await db.transaction('rw', db.threads, db.messages, db.runs, async () => {
    await db.messages.where('threadId').equals(id).delete();
    await db.runs.where('threadId').equals(id).delete();
    await db.threads.delete(id);
  });
}

/* ---------- Message operations ---------- */

export async function getMessages(threadId: string): Promise<Message[]> {
  return db.messages
    .where('[threadId+createdAt]')
    .between([threadId, ''], [threadId, '\uffff'])
    .toArray();
}

export async function addMessage(message: Message): Promise<void> {
  await db.messages.add(message);
  await db.threads.update(message.threadId, {
    updatedAt: new Date().toISOString(),
  });
}

export async function updateMessageContent(
  id: string,
  content: string,
): Promise<void> {
  const message = await db.messages.get(id);
  if (!message) return;
  await db.messages.update(id, { content });
  await db.threads.update(message.threadId, {
    updatedAt: new Date().toISOString(),
  });
}

/** Remove assistant/tool messages after a user message (for retry). */
export async function deleteMessagesAfter(
  threadId: string,
  afterMessageId: string,
): Promise<void> {
  const messages = await getMessages(threadId);
  const index = messages.findIndex((m) => m.id === afterMessageId);
  if (index === -1) return;

  const idsToDelete = messages.slice(index + 1).map((m) => m.id);
  if (idsToDelete.length === 0) return;

  await db.messages.bulkDelete(idsToDelete);
  await db.threads.update(threadId, {
    updatedAt: new Date().toISOString(),
  });
}

/* ---------- Run operations ---------- */

export async function getRuns(threadId: string): Promise<Run[]> {
  return db.runs.where('threadId').equals(threadId).toArray();
}

export async function addRun(run: Run): Promise<void> {
  await db.runs.add(run);
}

export async function updateRun(
  id: string,
  changes: Partial<Run>,
): Promise<void> {
  await db.runs.update(id, changes);
}
