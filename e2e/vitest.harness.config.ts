import { defineConfig } from 'vitest/config';

/** Isolated lifecycle controls: no application server, asset checkout or Docker setup. */
export default defineConfig({
  test: {
    include: ['src/harness-context.spec.ts'],
    maxWorkers: 1,
    fileParallelism: false,
  },
});
