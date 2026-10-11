import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const address = process.env.IMMICH_TEST_POSTGRES_URL;
if (!address) throw new Error('FL111 requires the root-owned migrated template URL');
const url = new URL(address);
if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('FL111 refuses nonlocal test PostgreSQL');
const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [swc.vite()],
  test: {
    name: 'server:fl111',
    root: serverRoot,
    globals: true,
    fileParallelism: false,
    include: [
      'test/medium/specs/schema/studio-import-publication.spec.ts',
      'test/medium/specs/repositories/studio-import-publication.repository.spec.ts',
      'test/medium/specs/repositories/studio-project.repository.spec.ts',
      'test/medium/specs/services/studio-import-retention.service.spec.ts',
      'test/medium/specs/repositories/buddy-backup-studio-retention.spec.ts',
    ],
    env: { TZ: 'UTC' },
  },
});
