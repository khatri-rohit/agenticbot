import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/**
 * node:sqlite, loaded at call time. Bundlers (the viewer's Turbopack) cannot
 * externalize this builtin from a static import; getBuiltinModule needs Node 22.3+.
 */
function openReadOnly(file: string): DatabaseSync {
  const sqlite = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  return new sqlite.DatabaseSync(file, { readOnly: true });
}

/**
 * Thread row from `catalog.db`. A read contract over the columns the API's
 * ThreadStore writes (apps/api/src/threads/thread-store.ts), not its type.
 */
export type ThreadRecord = {
  id: string;
  title: string;
  model: string;
  kind: string;
  createdAt: string;
  updatedAt: string;
  workspaceRoot?: string;
  /** Set on sub-agent threads. */
  parentThreadId?: string;
  parentRunId?: string;
  subagentProfile?: string;
  contextWindowMode?: string;
};

type CatalogRow = {
  id: string;
  title: string;
  model: string;
  kind: string | null;
  created_at: string;
  updated_at: string;
  workspace_root: string | null;
  parent_thread_id: string | null;
  parent_run_id: string | null;
  subagent_profile: string | null;
  context_window_mode: string | null;
};

/** Columns added by later migrations may be absent in an old catalog. */
function columns(db: DatabaseSync): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(threads)`).all() as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

/**
 * All threads, newest first. Opened read-only: the catalog runs in WAL mode
 * and a normal open would write side files into the agent home.
 */
export function readCatalog(home: string): ThreadRecord[] {
  const db = openReadOnly(path.join(home, 'catalog.db'));
  try {
    const have = columns(db);
    const optional = (name: string) => (have.has(name) ? name : `NULL AS ${name}`);
    const rows = db
      .prepare(
        `SELECT id, title, model, ${optional('kind')}, created_at, updated_at,
                ${optional('workspace_root')}, ${optional('parent_thread_id')},
                ${optional('parent_run_id')}, ${optional('subagent_profile')},
                ${optional('context_window_mode')}
         FROM threads ORDER BY updated_at DESC`,
      )
      .all() as CatalogRow[];
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      model: row.model,
      kind: row.kind ?? 'home',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.workspace_root ? { workspaceRoot: row.workspace_root } : {}),
      ...(row.parent_thread_id ? { parentThreadId: row.parent_thread_id } : {}),
      ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
      ...(row.subagent_profile ? { subagentProfile: row.subagent_profile } : {}),
      ...(row.context_window_mode ? { contextWindowMode: row.context_window_mode } : {}),
    }));
  } finally {
    db.close();
  }
}
