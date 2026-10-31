import { defineConfig } from 'vitest/config';

// Own isolated runtime + trusted TLS provider required; this command never starts shared Docker resources.
export default defineConfig({
  test: {
    name: 'e2e:owner-backup',
    include: ['src/specs/qualification/cloud-backup-owner.e2e-spec.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    maxWorkers: 1,
    isolate: false,
  },
  resolve: { tsconfigPaths: true },
});
