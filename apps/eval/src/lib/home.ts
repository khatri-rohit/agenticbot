import { existsSync } from 'node:fs';
import path from 'node:path';

/** Repo root: the nearest ancestor with nx.json (dev and build run from apps/eval or the root). */
function repoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(path.join(dir, 'nx.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

/** The agent home to read: `EVAL_AGENT_HOME`, else `AGENT_HOME`, else this repo's default. */
export function agentHome(): string {
  const configured = process.env.EVAL_AGENT_HOME ?? process.env.AGENT_HOME;
  if (configured) return path.resolve(repoRoot(), configured);
  return path.join(repoRoot(), '.local', 'personal-assistant');
}
