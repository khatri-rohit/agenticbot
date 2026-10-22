import type {
  MemoryCaps,
  MemoryFiles,
  MemoryGateResult,
  MemoryTarget,
  ProposedMemoryOp,
} from '@agent/agent-models';
import { DEFAULT_MEMORY_CAPS } from '@agent/agent-models';

const SECRET_RE =
  /sk-[a-zA-Z0-9]{16,}|api[_-]?key\s*[:=]|bearer\s+[a-z0-9\-._~+/]+=*|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;

function targetKey(target: MemoryTarget): 'user' | 'notes' | 'project' | 'skill' {
  if (target === 'user' || target === 'notes') return target;
  if ('project' in target) return 'project';
  return 'skill';
}

function fileFor(
  files: MemoryFiles,
  target: MemoryTarget,
): string | undefined {
  const key = targetKey(target);
  if (key === 'user') return files.user;
  if (key === 'notes') return files.notes;
  if (key === 'project') return files.project ?? '';
  return undefined;
}

function capFor(caps: MemoryCaps, target: MemoryTarget): number | undefined {
  const key = targetKey(target);
  if (key === 'user') return caps.userChars;
  if (key === 'notes') return caps.notesChars;
  if (key === 'project') return caps.projectChars;
  return undefined;
}

export function applyMemoryText(
  file: string,
  op: ProposedMemoryOp,
): string | { error: string } {
  if (op.action === 'add') {
    const chunk = (op.content ?? '').trim();
    if (!chunk) return { error: 'add requires content' };
    if (file.includes(chunk)) return { error: 'duplicate entry' };
    return file.trim() ? `${file.trim()}\n\n${chunk}` : chunk;
  }

  const span = (op.oldText ?? '').trim();
  if (!span) return { error: 'patch/remove requires a unique oldText span' };
  const count = file.split(span).length - 1;
  if (count === 0)
    return {
      error:
        'oldText span not found — a later op may have modified it; revert that one first',
    };
  if (count > 1) return { error: 'oldText span is not unique' };

  if (op.action === 'remove') {
    return replaceOnce(file, span, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  const next = (op.content ?? '').trim();
  if (!next) return { error: 'patch requires content' };
  return replaceOnce(file, span, next);
}

/** Literal replace of one unique span — String.replace interpolates `$`. */
function replaceOnce(haystack: string, needle: string, replacement: string): string {
  const index = haystack.indexOf(needle);
  if (index < 0) return haystack;
  return haystack.slice(0, index) + replacement + haystack.slice(index + needle.length);
}

function looksLikeSecret(text: string): boolean {
  return SECRET_RE.test(text);
}

/**
 * Deterministic memory gate. Same files + ops → same verdicts. No disk, no model.
 */
export function gateMemoryOps(
  current: MemoryFiles,
  proposed: ProposedMemoryOp[],
  caps: MemoryCaps = DEFAULT_MEMORY_CAPS,
): MemoryGateResult[] {
  const working: MemoryFiles = { ...current };
  const results: MemoryGateResult[] = [];

  for (const op of proposed) {
    if (!op.reason?.trim() || !op.source?.threadId) {
      results.push({ op, verdict: 'reject', why: 'missing reason or source' });
      continue;
    }

    const key = targetKey(op.target);
    if (key === 'skill') {
      results.push({
        op,
        verdict: 'stage',
        why: 'skill writes are staged',
      });
      continue;
    }

    const blob = [op.content, op.oldText, op.reason].filter(Boolean).join('\n');
    if (looksLikeSecret(blob)) {
      results.push({ op, verdict: 'reject', why: 'looks like a secret' });
      continue;
    }

    if (op.evidence === 'external') {
      results.push({
        op,
        verdict: 'stage',
        why: 'external evidence is staged',
      });
      continue;
    }

    if (op.by === 'review' && key === 'user') {
      results.push({
        op,
        verdict: 'stage',
        why: 'review edits to USER.md are staged',
      });
      continue;
    }

    const file = fileFor(working, op.target) ?? '';
    const next = applyMemoryText(file, op);
    if (typeof next !== 'string') {
      results.push({ op, verdict: 'reject', why: next.error });
      continue;
    }

    const cap = capFor(caps, op.target);
    if (cap !== undefined && next.length > cap) {
      results.push({
        op,
        verdict: 'reject',
        why: `over cap (${next.length} > ${cap} chars); consolidate first`,
      });
      continue;
    }

    if (key === 'user') working.user = next;
    else if (key === 'notes') working.notes = next;
    else working.project = next;

    results.push({ op, verdict: 'apply', why: 'ok' });
  }

  return results;
}
