import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { MemoryFiles, MemoryOp, ProposedMemoryOp } from '@agent/agent-models';
import { parseMemoryOp, workspaceRootKey } from '@agent/agent-models';
import { applyMemoryText, gateMemoryOps } from '@agent/agent-core';

export class MemoryStore {
  readonly home: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(home: string) {
    this.home = home;
  }

  private dir(): string {
    return path.join(this.home, 'memory');
  }

  private userPath(): string {
    return path.join(this.dir(), 'USER.md');
  }

  private notesPath(workspaceRoot?: string): string {
    if (!workspaceRoot) return path.join(this.dir(), 'MEMORY.md');
    const key = createHash('sha256')
      .update(workspaceRootKey(workspaceRoot))
      .digest('hex')
      .slice(0, 24);
    return path.join(this.dir(), 'workspaces', key, 'MEMORY.md');
  }

  private opsPath(): string {
    return path.join(this.dir(), 'ops.jsonl');
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async ensure(workspaceRoot?: string): Promise<void> {
    await mkdir(this.dir(), { recursive: true });
    await mkdir(path.join(this.dir(), 'pending'), { recursive: true });
    await this.ensureFile(this.userPath());
    await this.ensureFile(this.notesPath());
    await this.ensureFile(this.opsPath());
    if (workspaceRoot) {
      const notes = this.notesPath(workspaceRoot);
      await mkdir(path.dirname(notes), { recursive: true });
      await this.ensureFile(notes);
    }
  }

  async read(workspaceRoot?: string): Promise<MemoryFiles> {
    await this.ensure(workspaceRoot);
    const [user, notes] = await Promise.all([
      readFile(this.userPath(), 'utf8'),
      readFile(this.notesPath(workspaceRoot), 'utf8'),
    ]);
    return { user, notes };
  }

  async listOps(): Promise<MemoryOp[]> {
    await this.ensure();
    const raw = await readFile(this.opsPath(), 'utf8');
    const ops: MemoryOp[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      // A truncated record (crash mid-append) must not fail the whole list;
      // skip it like parseMemoryOp rejects a structurally invalid op.
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const op = parseMemoryOp(parsed);
      if (op) ops.push(op);
    }
    return ops;
  }

  apply(
    proposed: ProposedMemoryOp,
    workspaceRoot?: string,
  ): Promise<MemoryOp> {
    return this.serialize(() => this.applyUnlocked(proposed, workspaceRoot));
  }

  stage(
    proposed: ProposedMemoryOp,
    workspaceRoot?: string,
  ): Promise<MemoryOp> {
    return this.serialize(async () => {
      await this.ensure(workspaceRoot);
      const op = this.toOp(proposed, 'staged');
      await this.appendOp(op);
      return op;
    });
  }

  writeUser(content: string, source: MemoryOp['source']): Promise<MemoryOp> {
    return this.serialize(async () => {
      const files = await this.read();
      const trimmed = content.trim();
      if (!trimmed && !files.user.trim()) {
        return this.toOp(
          {
            target: 'user',
            action: 'remove',
            reason: 'user cleared USER.md',
            source,
            by: 'user',
            evidence: 'user-said',
          },
          'applied',
        );
      }

      const proposed: ProposedMemoryOp = !trimmed
        ? {
            target: 'user',
            action: 'remove',
            oldText: files.user,
            reason: 'user cleared USER.md',
            source,
            by: 'user',
            evidence: 'user-said',
          }
        : {
            target: 'user',
            action: files.user.trim() ? 'patch' : 'add',
            oldText: files.user.trim() ? files.user : undefined,
            content: trimmed,
            reason: 'user edited USER.md',
            source,
            by: 'user',
            evidence: 'user-said',
          };

      return this.applyUnlocked(proposed);
    });
  }

  revert(opId: string, workspaceRoot?: string): Promise<MemoryOp> {
    return this.serialize(async () => {
      const ops = await this.listOps();
      const original = ops.find((op) => op.id === opId);
      if (!original || original.status !== 'applied') {
        throw new Error('Applied op not found');
      }
      if (original.target !== 'user' && original.target !== 'notes') {
        throw new Error('Can only revert user or notes ops');
      }

      const inverse: ProposedMemoryOp = {
        target: original.target,
        action:
          original.action === 'add'
            ? 'remove'
            : original.action === 'remove'
              ? 'add'
              : 'patch',
        oldText:
          original.action === 'add'
            ? original.oldText ?? original.content
            : original.action === 'patch'
              ? original.content
              : undefined,
        content:
          original.action === 'remove'
            ? original.oldText
            : original.action === 'patch'
              ? original.oldText
              : undefined,
        reason: `revert ${opId}`,
        source: original.source,
        by: 'user',
        evidence: original.evidence,
      };

      return this.applyUnlocked(inverse, workspaceRoot);
    });
  }

  private async applyUnlocked(
    proposed: ProposedMemoryOp,
    workspaceRoot?: string,
  ): Promise<MemoryOp> {
    const files = await this.read(
      proposed.target === 'notes' ? workspaceRoot : undefined,
    );
    const [gated] = gateMemoryOps(files, [proposed]);
    if (!gated || gated.verdict !== 'apply') {
      throw new Error(gated?.why ?? 'rejected');
    }

    const file =
      proposed.target === 'user'
        ? files.user
        : proposed.target === 'notes'
          ? files.notes
          : '';
    const next = applyMemoryText(file, proposed);
    if (typeof next !== 'string') {
      throw new Error(next.error);
    }

    const op = this.toOp(proposed, 'applied');
    if (proposed.action === 'add') {
      op.oldText = (proposed.content ?? '').trim();
    }

    if (proposed.target === 'user') {
      await writeFile(this.userPath(), next, 'utf8');
    } else if (proposed.target === 'notes') {
      await writeFile(this.notesPath(workspaceRoot), next, 'utf8');
    }
    await this.appendOp(op);
    return op;
  }

  private toOp(
    proposed: ProposedMemoryOp,
    status: MemoryOp['status'],
  ): MemoryOp {
    return {
      v: 1,
      id: randomUUID(),
      ts: new Date().toISOString(),
      ...proposed,
      status,
    };
  }

  private async appendOp(op: MemoryOp): Promise<void> {
    await writeFile(this.opsPath(), `${JSON.stringify(op)}\n`, {
      flag: 'a',
    });
  }

  private async ensureFile(filePath: string): Promise<void> {
    try {
      await writeFile(filePath, '', { flag: 'wx' });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw error;
    }
  }
}
