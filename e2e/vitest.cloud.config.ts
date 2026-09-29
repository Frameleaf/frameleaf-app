import { defineConfig } from 'vitest/config';

/**
 * FL-201: specs that need the fake Frameleaf Cloud. They run against a stack started with
 * `docker compose -f docker-compose.yml -f docker-compose.frameleaf-cloud-fixture.yml up`, never
 * as part of `pnpm test`, whose specs expect the default (unreachable) cloud address.
 */
export default defineConfig({
  test: {
    name: 'e2e:cloud',
    retry: process.env.CI ? 2 : 0,
    include: ['src/specs/cloud/**/*.e2e-spec.ts'],
    testTimeout: 60_000,
    pool: 'threads',
    maxWorkers: 1,
    isolate: false,
  },
  resolve: {
    tsconfigPaths: true,
  },
});
