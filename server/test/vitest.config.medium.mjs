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
    ...(process.env.FRAMELEAF_MEDIUM_SUITE === 'scale' && process.env.FRAMELEAF_MEDIUM_DIAGNOSTICS === '1'
      ? {
          reporters: [
            'default',
            [
              'junit',
              {
                outputFile: '/tmp/frameleaf-medium-scale-reports/vitest.xml',
                includeConsoleOutput: false,
              },
            ],
          ],
        }
      : {}),
    fileParallelism: false,
    // The self-hosted CI slots run real ffmpeg, Postgres and file work slower than GitHub's VMs did; the 5 s / 10 s
    // defaults turned that into random timeouts. Tests that need longer still set their own.
    testTimeout: 20_000,
    hookTimeout: 30_000,
    root: serverRoot,
    globals: true,
    include: suite.include,
    exclude: [...configDefaults.exclude, ...suite.exclude],
    globalSetup: ['test/medium/globalSetup.ts'],
  },
  plugins: [swc.vite()],
});
