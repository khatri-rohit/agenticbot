import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/web',
  test: {
    name: '@agent/web',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}'],
    // No web tests yet; an empty suite must not fail `nx run-many -t test`.
    passWithNoTests: true,
  },
});
