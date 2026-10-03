import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Two actual app images; only external coordination and edge enrollment are fixtures.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    name: 'server:buddy-two-server',
    root: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    globals: true,
    include: ['test/transport/buddy-backup.spec.ts'],
    maxWorkers: 1,
    fileParallelism: false,
    retry: 0,
    testTimeout: 600_000,
    hookTimeout: 60_000,
  },
  plugins: [swc.vite()],
});
