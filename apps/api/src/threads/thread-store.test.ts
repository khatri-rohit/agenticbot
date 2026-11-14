import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RunTaskRecord } from '@agent/agent-models';

import { openThreadStore, type ThreadStore } from './thread-store';

let home: string;
let store: ThreadStore;

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'thread-store-'));
  store = await openThreadStore(home);
});

afterAll(async () => {
  // SQLite holds the catalog open (and Windows will not unlink an open file).
  store.close();
  await rm(home, { recursive: true, force: true });
});

const record = (runId: string, claim: string): RunTaskRecord => ({
  runId,
  finishedAt: '2026-11-14T00:00:00.000Z',
  findings: [{ claim, evidence: 'src/a.ts:1', iteration: 1, verification: 'verified' }],
  openQuestions: [],
});

describe('task records', () => {
  it('keeps one record per run, oldest first, and a re-run of the same id replaces it', async () => {
    const thread = await store.createThread('m');
    await store.appendTaskRecord(thread.id, record('r1', 'first'));
    await store.appendTaskRecord(thread.id, record('r2', 'second'));
    await store.appendTaskRecord(thread.id, record('r1', 'first again'));
    const records = await store.readTaskRecords(thread.id);
    expect(records.map((entry) => `${entry.runId}:${entry.findings[0]!.claim}`)).toEqual(['r2:second', 'r1:first again']);
  });

  it('drops the records of runs a rewind cuts', async () => {
    const thread = await store.createThread('m');
    await store.append({ threadId: thread.id, runId: null, record: { role: 'user', content: 'one' } });
    await store.append({ threadId: thread.id, runId: 'r1', record: { role: 'assistant', content: 'answer one' } });
    await store.append({ threadId: thread.id, runId: null, record: { role: 'user', content: 'two' } });
    await store.append({ threadId: thread.id, runId: 'r2', record: { role: 'assistant', content: 'answer two' } });
    await store.appendTaskRecord(thread.id, record('r1', 'kept'));
    await store.appendTaskRecord(thread.id, record('r2', 'cut'));
    await store.rewind(thread.id, 2);
    expect((await store.readTaskRecords(thread.id)).map((entry) => entry.runId)).toEqual(['r1']);
  });

  it('reads an empty list for a thread with no records', async () => {
    const thread = await store.createThread('m');
    expect(await store.readTaskRecords(thread.id)).toEqual([]);
  });
});
