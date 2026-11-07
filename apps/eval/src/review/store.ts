import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseThreadReview, type ThreadReview } from '@agent/agent-models';

function reviewPath(home: string, threadId: string): string {
  return path.join(home, 'reviews', `${threadId}.json`);
}

export async function readReview(home: string, threadId: string): Promise<ThreadReview | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(reviewPath(home, threadId), 'utf8'));
    return parseThreadReview(raw);
  } catch {
    return null;
  }
}

export async function writeReview(home: string, review: ThreadReview): Promise<void> {
  const file = reviewPath(home, review.threadId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(review, null, 2)}\n`, 'utf8');
}
