import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { compareToBaseline, type Baseline } from './gate.js';
import type { SuiteStats } from './summary.js';

export function baselinePath(baselinesDir: string, suite: string): string {
  return path.join(baselinesDir, `${suite}.json`);
}

type StoredBaseline = Baseline & { integrity: string };

/** Hash of everything but the integrity field: catches hand edits. */
function integrityOf(baseline: Baseline): string {
  return createHash('sha256').update(JSON.stringify(baseline)).digest('hex');
}

/**
 * The stored baseline, or null when there is none. Throws when the file was
 * edited by hand: baselines are written only by `baseline`.
 */
export async function readBaseline(baselinesDir: string, suite: string): Promise<Baseline | null> {
  let text: string;
  try {
    text = await readFile(baselinePath(baselinesDir, suite), 'utf8');
  } catch {
    return null;
  }
  const { integrity, ...baseline } = JSON.parse(text) as StoredBaseline;
  if (integrity !== integrityOf(baseline)) {
    throw new Error(
      `${baselinePath(baselinesDir, suite)} was edited by hand (integrity hash mismatch). Restore it from git or record a new one with: baseline --accept "<reason>".`,
    );
  }
  return baseline;
}

/**
 * Write the baseline. Allowed when there is none yet, when the candidate
 * passes the gate against the current one, or with an explicit accept reason
 * (an intended trade-off); the reason is stored in the file.
 */
export async function recordBaseline(input: {
  baselinesDir: string;
  suite: string;
  stats: SuiteStats;
  acceptReason?: string;
}): Promise<{ written: true; path: string } | { written: false; why: string }> {
  // A tampered baseline can only be replaced deliberately.
  const current = input.acceptReason
    ? await readBaseline(input.baselinesDir, input.suite).catch(() => null)
    : await readBaseline(input.baselinesDir, input.suite);
  if (current && !input.acceptReason) {
    const result = compareToBaseline(current, input.stats);
    if (result.kind === 'refuse') {
      return { written: false, why: `gate refused: ${result.reasons.join('; ')}. Use --accept "<reason>" to replace it.` };
    }
    if (!result.passed) {
      return { written: false, why: 'the candidate fails the gate against the current baseline. Use --accept "<reason>" if this is intended.' };
    }
  }
  const baseline: Baseline = {
    suite: input.suite,
    recordedAt: new Date().toISOString(),
    ...input.stats,
    ...(input.acceptReason ? { acceptReason: input.acceptReason } : {}),
  };
  await mkdir(input.baselinesDir, { recursive: true });
  const file = baselinePath(input.baselinesDir, input.suite);
  const stored: StoredBaseline = { ...baseline, integrity: integrityOf(baseline) };
  await writeFile(file, `${JSON.stringify(stored, null, 2)}\n`);
  return { written: true, path: file };
}
