import unit from './vitest.config.mjs';

// Hosted native qualification: explicitly invoked; missing engine/fixture fails, never skips.
export default {
  ...unit,
  test: {
    ...unit.test,
    name: 'server:darktable',
    include: ['test/native/darktable.spec.ts'],
    testTimeout: 600_000,
    maxWorkers: 1,
    retry: 0,
  },
};
