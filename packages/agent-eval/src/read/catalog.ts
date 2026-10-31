import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

/**
 * Thread row from catalog.db, read-only. Mirrors the columns the API's
 * ThreadStore writes (apps/api/src/lib/thread-store.ts). We do not import
 * the API's type — this is a stable read contract over the DB schema.
 */
export type ThreadRecord = {
  id: string;
  title: string;
  model: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  kind: string;
  workspaceRoot?: string;
  parentThreadId?: string;
  parentRunId?: string;
  contextWindowMode?: string;
};

type CatalogRow = {
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

function rowToThread(row: CatalogRow): ThreadRecord {
  return {
    id: row.id,
    title: row.title,
    model: row.model,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    kind: row.kind ?? 'home',
    ...(row.workspace_root ? { workspaceRoot: row.workspace_root } : {}),
    ...(row.parent_thread_id ? { parentThreadId: row.parent_thread_id } : {}),
    ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
    ...(row.context_window_mode
      ? { contextWindowMode: row.context_window_mode }
      : {}),
  };
}

/**
 * Open catalog.db read-only and return all threads. A plain open would create
 * WAL/shm side files in $AGENT_HOME; readOnly prevents that.
 */
export function readCatalog(home: string): ThreadRecord[] {
  const dbPath = path.join(home, 'catalog.db');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT * FROM threads ORDER BY updated_at DESC').all() as CatalogRow[];
    return rows.map(rowToThread);
  } finally {
    db.close();
  }
}