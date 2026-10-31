import { defineConfig } from 'vitest/config';

// Explicit isolated normal-auth runtime required; this does not start Docker.
export default defineConfig({
  test: {
    name: 'e2e:owner-restore',
    include: ['src/specs/qualification/cloud-backup-owner-restore.e2e-spec.ts'],
    testTimeout: 600_000,
    hookTimeout: 60_000,
    maxWorkers: 1,
    isolate: false,
  },
  resolve: { tsconfigPaths: true },
});
