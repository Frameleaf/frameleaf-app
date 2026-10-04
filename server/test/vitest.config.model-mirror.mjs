import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Network check (FL-330): default ML models must resolve on the Frameleaf model mirror. Not part of the offline unit suite.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    name: 'server:model-mirror',
    root: serverRoot,
    globals: true,
    include: ['test/model-mirror/**/*.spec.ts'],
    testTimeout: 60_000,
    env: {
      TZ: 'UTC',
    },
  },
  plugins: [swc.vite()],
});
