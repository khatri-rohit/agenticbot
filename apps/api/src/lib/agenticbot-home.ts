import path from 'node:path';

export type ResolveAgenticbotHomeInput = {
  /** Env map to read AGENTICBOT_HOME from. Defaults are never taken from cwd. */
  env: Record<string, string | undefined>;
  /** Injected user home (os.homedir() in production). */
  homedir: string;
};

/**
 * Resolve the durable agent home directory (pure — no mkdir or I/O).
 *
 * 1. AGENTICBOT_HOME if set → path.resolve (absolute)
 * 2. else → path.join(homedir, '.local', 'agenticbot') on all platforms
 */
export function resolveAgenticbotHome(input: ResolveAgenticbotHomeInput): string {
  const configured = input.env.AGENTICBOT_HOME;
  if (configured !== undefined && configured !== '') {
    return path.resolve(configured);
  }
  return path.join(input.homedir, '.local', 'agenticbot');
}
