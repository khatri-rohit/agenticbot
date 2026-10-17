import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { openThreadStore, type ThreadStore } from './thread-store.js';

describe('ThreadStore', () => {
  let store: ThreadStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
  });

  it('creates a thread, appends user+assistant, survives reopen', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'agenticbot-store-'));
    store = await openThreadStore(home);
    const thread = await store.createThread('test-model');

    await store.append({
      threadId: thread.id,
      runId: null,
      record: { role: 'user', content: 'hello' },
    });
    await store.append({
      threadId: thread.id,
      runId: 'run-1',
      record: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":"nx"}' },
          },
        ],
      },
    });
    await store.append({
      threadId: thread.id,
      runId: 'run-1',
      record: { role: 'tool', tool_call_id: 'call_1', content: 'source A' },
    });
    await store.append({
      threadId: thread.id,
      runId: 'run-1',
      record: { role: 'assistant', content: 'Nx uses a local cache.' },
    });

    store.close();
    store = await openThreadStore(home);

    const messages = await store.toChatMessages(thread.id);
    expect(messages).toEqual([
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'web_search', arguments: '{"query":"nx"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'source A' },
      { role: 'assistant', content: 'Nx uses a local cache.' },
    ]);

    const listed = store.listThreads();
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(thread.id);
  });

  it('offloads large tool bodies to blobs and hydrates on read', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'agenticbot-store-'));
    store = await openThreadStore(home);
    const thread = await store.createThread('test-model');
    const big = 'x'.repeat(9 * 1024);

    const envelope = await store.append({
      threadId: thread.id,
      runId: 'run-1',
      record: { role: 'tool', tool_call_id: 'c1', content: big },
    });

    expect(envelope.contentBlob).toBeTruthy();
    expect(envelope.record.role === 'tool' && envelope.record.content).toContain(
      'sha256:',
    );

    const raw = await readFile(
      path.join(home, 'sessions', thread.id, 'ledger.jsonl'),
      'utf8',
    );
    expect(raw).not.toContain(big);

    const messages = await store.toChatMessages(thread.id);
    expect(messages[0]).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: big,
    });
  });

  it('rewinds through a seq and drops later lines', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'agenticbot-store-'));
    store = await openThreadStore(home);
    const thread = await store.createThread('test-model');
    await store.append({
      threadId: thread.id,
      runId: null,
      record: { role: 'user', content: 'q' },
    });
    await store.append({
      threadId: thread.id,
      runId: 'r',
      record: { role: 'assistant', content: 'a' },
    });

    await store.rewind(thread.id, 1);
    const messages = await store.toChatMessages(thread.id);
    expect(messages).toEqual([{ role: 'user', content: 'q' }]);

    // Appends after rewind continue from the new tail.
    const next = await store.append({
      threadId: thread.id,
      runId: 'r2',
      record: { role: 'assistant', content: 'a2' },
    });
    expect(next.seq).toBe(2);
  });

  it('recovers seq from the ledger tail when the catalog is stale', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'agenticbot-store-'));
    store = await openThreadStore(home);
    const thread = await store.createThread('test-model');
    await store.append({
      threadId: thread.id,
      runId: null,
      record: { role: 'user', content: 'one' },
    });

    store.close();
    // Simulate a crash between ledger datasync and the catalog update:
    // rewind the catalog's last_seq behind the real file tail.
    const db = new DatabaseSync(path.join(home, 'catalog.db'));
    db.prepare(`UPDATE threads SET last_seq = ? WHERE id = ?`).run(0, thread.id);
    db.close();

    store = await openThreadStore(home);
    const second = await store.append({
      threadId: thread.id,
      runId: null,
      record: { role: 'user', content: 'two' },
    });
    expect(second.seq).toBe(2);

    const messages = await store.toChatMessages(thread.id);
    expect(messages.map((m) => m.content)).toEqual(['one', 'two']);
  });

  it('skips and repairs a torn tail line after a crash mid-append', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'agenticbot-store-'));
    store = await openThreadStore(home);
    const thread = await store.createThread('test-model');
    await store.append({
      threadId: thread.id,
      runId: null,
      record: { role: 'user', content: 'one' },
    });

    // Simulate a crash mid-write: a half line lands at the tail.
    const ledgerPath = path.join(home, 'sessions', thread.id, 'ledger.jsonl');
    await writeFile(ledgerPath, '{"v":1,"seq":2,"ts":"x","th', {
      flag: 'a',
    });

    // Reads skip the torn line without crashing.
    const messages = await store.toChatMessages(thread.id);
    expect(messages).toEqual([{ role: 'user', content: 'one' }]);

    // Reopen (as after a restart): the append path repairs the tail and
    // the next envelope continues the sequence without reusing seq 2.
    store.close();
    store = await openThreadStore(home);
    const third = await store.append({
      threadId: thread.id,
      runId: null,
      record: { role: 'user', content: 'three' },
    });
    expect(third.seq).toBe(2);

    const raw = await readFile(ledgerPath, 'utf8');
    expect(raw).not.toContain('"ts":"x"');
    const messagesAfter = await store.toChatMessages(thread.id);
    expect(messagesAfter.map((m) => m.content)).toEqual(['one', 'three']);
  });
});
