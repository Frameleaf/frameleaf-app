import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    name: 'server:transport',
    root: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    globals: true,
    include: ['test/transport/asset-upload-relay.spec.ts'],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
  plugins: [swc.vite()],
});
