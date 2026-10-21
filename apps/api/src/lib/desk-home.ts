import path from 'node:path';

export type ResolveDeskHomeInput = {
  /** Env map to read DESK_HOME from. Defaults are never taken from cwd. */
  env: Record<string, string | undefined>;
  /** Injected user home (os.homedir() in production). */
  homedir: string;
};

/**
 * Resolve the durable agent home directory (pure — no mkdir or I/O).
 *
 * 1. DESK_HOME if set → path.resolve (absolute)
 * 2. else → path.join(homedir, '.local', 'desk') on all platforms
 */
export function resolveDeskHome(input: ResolveDeskHomeInput): string {
  const configured = input.env.DESK_HOME;
  if (configured !== undefined && configured !== '') {
    return path.resolve(configured);
  }
  return path.join(input.homedir, '.local', 'desk');
}
