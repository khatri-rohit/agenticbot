import path from 'node:path';

export type Args = {
  positional: string[];
  flags: Map<string, string | true>;
};

/** `--key value`, `--key=value` and bare `--flag`. */
export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 0) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(arg.slice(2), next);
      i += 1;
    } else {
      flags.set(arg.slice(2), true);
    }
  }
  return { positional, flags };
}

export function flag(args: Args, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

export function has(args: Args, name: string): boolean {
  return args.flags.has(name);
}

export function intFlag(args: Args, name: string, fallback: number): number {
  const value = Number(flag(args, name));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** The personal agent home: `--home`, else `$AGENT_HOME`, else this repo's default. */
export function agentHome(args: Args): string {
  return path.resolve(flag(args, 'home') ?? process.env.AGENT_HOME ?? '.local/personal-assistant');
}

/** The eval agent home (plan §5): `--eval-home`, else `.local/eval-home`. */
export function evalHome(args: Args): string {
  return path.resolve(flag(args, 'eval-home') ?? '.local/eval-home');
}
