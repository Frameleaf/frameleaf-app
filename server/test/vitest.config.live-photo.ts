import { defineConfig } from 'vitest/config';

// Deliberately opt-in: this configuration never creates, resets or stops Docker resources.
export default defineConfig({
  test: {
    globals: true,
    include: ['test/transport/live-photo-upload.spec.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    maxWorkers: 1,
    retry: 0,
  },
});
