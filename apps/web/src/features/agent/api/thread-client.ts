import type { Message, Thread, ThreadKind } from '@org/agent-models';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3333';

async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return (body as { error?: string }).error ?? fallback;
}

/** Opens the host OS folder dialog. Returns null if cancelled. */
export async function pickWorkspaceFolder(
  initialDir?: string | null,
): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/agent/workspace/pick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        initialDir?.trim() ? { initialDir: initialDir.trim() } : {},
      ),
    });
  } catch {
    throw new Error(
      `Cannot reach the API at ${API_BASE}. Start it with nx serve @org/api, then try again.`,
    );
  }
  if (res.status === 204) return null;
  if (!res.ok) {
    throw new Error(await readError(res, `Failed to pick folder: ${res.status}`));
  }
  const body = (await res.json()) as { workspaceRoot?: string };
  return body.workspaceRoot?.trim() ? body.workspaceRoot : null;
}

export async function listThreads(): Promise<Thread[]> {
  const res = await fetch(`${API_BASE}/api/agent/threads`);
  if (!res.ok) {
    throw new Error(await readError(res, `Failed to list threads: ${res.status}`));
  }
  const body = (await res.json()) as { threads: Thread[] };
  return body.threads;
}

export async function createThread(
  title: string,
  model: string,
  options?: { kind?: ThreadKind; workspaceRoot?: string },
): Promise<Thread> {
  const res = await fetch(`${API_BASE}/api/agent/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      model,
      ...(options?.kind ? { kind: options.kind } : {}),
      ...(options?.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(await readError(res, `Failed to create thread: ${res.status}`));
  }
  return res.json() as Promise<Thread>;
}

export async function fetchThread(id: string): Promise<Thread | undefined> {
  const res = await fetch(`${API_BASE}/api/agent/threads/${id}`);
  if (res.status === 404) return undefined;
  if (!res.ok) {
    throw new Error(await readError(res, `Failed to load thread: ${res.status}`));
  }
  return res.json() as Promise<Thread>;
}

export async function patchThread(
  id: string,
  changes: {
    title?: string;
    model?: string;
    pinned?: boolean;
    kind?: ThreadKind;
    workspaceRoot?: string | null;
  },
): Promise<Thread> {
  const res = await fetch(`${API_BASE}/api/agent/threads/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(changes),
  });
  if (!res.ok) {
    throw new Error(await readError(res, `Failed to update thread: ${res.status}`));
  }
  return res.json() as Promise<Thread>;
}

export async function deleteThread(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/agent/threads/${id}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    throw new Error(await readError(res, `Failed to delete thread: ${res.status}`));
  }
}

export type LedgerResponse = {
  messages: Message[];
  lastSeq: number;
  lastUserSeq?: number;
};

export async function fetchLedger(threadId: string): Promise<LedgerResponse> {
  const res = await fetch(`${API_BASE}/api/agent/threads/${threadId}/ledger`);
  if (!res.ok) {
    throw new Error(await readError(res, `Failed to load ledger: ${res.status}`));
  }
  return res.json() as Promise<LedgerResponse>;
}

export function seqFromMessageId(id: string): number | undefined {
  const seq = Number(id.split('_').at(-1));
  return Number.isFinite(seq) ? seq : undefined;
}
