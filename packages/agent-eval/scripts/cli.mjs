/**
 * Bundle src/cli/main.ts (workspace packages resolved to source via the
 * `@agent/source` condition) and run it with the remaining arguments.
 * Same idea as @agent/cli:eval: esbuild + node, no ts runtime needed.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outfile = path.join(packageRoot, 'dist-cli', 'cli.cjs');

await build({
  entryPoints: [path.join(packageRoot, 'src', 'cli', 'main.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  conditions: ['@agent/source'],
  outfile,
  logLevel: 'warning',
});

const result = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});
process.exit(result.status ?? 1);
