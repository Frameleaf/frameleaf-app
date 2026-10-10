import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const testingModule = process.env.FRAMELEAF_CLOUD_LIFECYCLE_TEST_MODULE;
if (!testingModule || !isAbsolute(testingModule) || !existsSync(testingModule)) {
  throw new Error(
    'Required FRAMELEAF_CLOUD_LIFECYCLE_TEST_MODULE must name an existing absolute compiled testing entrypoint',
  );
}

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    name: 'server:cloud-lifecycle-source',
    root: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    include: ['test/lifecycle/*.spec.ts', 'test/lifecycle/*.spec.mjs'],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  plugins: [swc.vite()],
});
