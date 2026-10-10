import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { configDefaults, defineConfig } from 'vitest/config';
import { mediumSuite } from './vitest.medium-suites.mjs';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const suite = mediumSuite(process.env.FRAMELEAF_MEDIUM_SUITE, serverRoot);

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    name: 'server:medium',
    fileParallelism: false,
    root: serverRoot,
    globals: true,
    include: suite.include,
    exclude: [...configDefaults.exclude, ...suite.exclude],
    globalSetup: ['test/medium/globalSetup.ts'],
  },
  plugins: [swc.vite()],
});
