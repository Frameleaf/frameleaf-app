import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    name: 'server:unit',
    // The self-hosted CI slots are slower than GitHub's VMs; 5 s timed out file-reading tests under load.
    testTimeout: 15_000,
    root: serverRoot,
    globals: true,
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/cores/**', 'src/services/**', 'src/utils/**', 'src/sql-tools/**'],
      exclude: [
        'src/services/*.spec.ts',
        'src/services/api.service.ts',
        'src/services/microservices.service.ts',
        'src/services/index.ts',
      ],
    },
    env: {
      TZ: 'UTC',
    },
  },
  plugins: [swc.vite()],
});
