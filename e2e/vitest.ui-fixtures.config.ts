import { defineConfig } from 'vitest/config';

/** Fixture contracts run without an application server, browser or Docker. */
export default defineConfig({
  test: { include: ['src/ui-fixture-contracts.spec.mjs'] },
  resolve: { tsconfigPaths: true },
});
