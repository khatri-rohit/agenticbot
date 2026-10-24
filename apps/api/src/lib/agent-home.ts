import path from 'node:path';

export type ResolveAgentHomeInput = {
  /** Env map to read AGENT_HOME from. Defaults are never taken from cwd. */
  env: Record<string, string | undefined>;
  /** Injected user home (os.homedir() in production). */
  homedir: string;
};

/**
 * Resolve the durable agent home directory (pure — no mkdir or I/O).
 *
 * 1. AGENT_HOME if set → path.resolve (absolute)
 * 2. else → path.join(homedir, '.local', 'personal-assistant')
 */
export function resolveAgentHome(input: ResolveAgentHomeInput): string {
  const configured = input.env.AGENT_HOME;
  if (configured !== undefined && configured !== '') {
    return path.resolve(configured);
  }
  return path.join(input.homedir, '.local', 'personal-assistant');
}
