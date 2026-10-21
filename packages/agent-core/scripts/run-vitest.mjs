/**
 * Normalize Windows drive-letter casing to uppercase before Vitest starts.
 * Nx often starts with a lowercase drive (d:\...), which can load @vitest/runner
 * twice (d: vs D:) and leave `runner` unset during suite collection.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const normalized =
  process.platform === 'win32'
    ? packageRoot.replace(
        /^([a-z]):/,
        (_, letter) => `${letter.toUpperCase()}:`,
      )
    : packageRoot;

process.chdir(normalized);

const result = spawnSync(
  process.execPath,
  [
    path.join(normalized, '../../node_modules/vitest/vitest.mjs'),
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit', env: process.env, cwd: normalized },
);

process.exit(result.status ?? 1);
