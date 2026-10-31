import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const root = resolve(import.meta.dirname, '..', '..', '..');
const shared = resolve(root, 'vitest.config.mts');
const config = existsSync(shared) ? shared : resolve(import.meta.dirname, '..', 'vitest.config.mts');

const args = process.argv.slice(2);
const mode = args[0] === 'run' ? 'run' : 'watch';

import(`file://${config}`).then(async () => {
  const { startVitest } = await import('vitest/node');
  await startVitest(mode === 'run' ? 'test' : [], [], {
    config: config,
    root: resolve(import.meta.dirname, '..'),
  });
}).catch((err) => {
  console.error(err);
  process.exit(1);
});