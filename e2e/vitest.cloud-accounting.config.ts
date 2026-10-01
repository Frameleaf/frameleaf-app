import { defineConfig } from 'vitest/config';

/** FL-159: real minute-cron/60s-poll worker against opt-in recorded-provider lifecycle. */
export default defineConfig({
  test: {
    name: 'e2e:cloud-accounting',
    retry: 0,
    // Separate suffix: the ordinary consent fixture/config must not pick up this opt-in case.
    include: ['src/specs/cloud/cloud-accounting.spec.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    pool: 'threads',
    maxWorkers: 1,
    isolate: false,
  },
  resolve: { tsconfigPaths: true },
});
