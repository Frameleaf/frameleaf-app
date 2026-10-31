import { defineConfig } from 'vitest/config';

/** Fixture contracts run without an application server, browser or Docker. */
export default defineConfig({
  test: {
    include: [
      'src/ui-fixture-contracts.spec.mjs',
      'src/backup-fixture.spec.ts',
      'src/fixtures/owner-backup-origin.spec.ts',
      'src/ui/generators/timeline/images.spec.ts',
      'src/ui/generators/memory/model-objects.spec.ts',
      'src/ui/generators/timeline/rest-response.spec.ts',
    ],
  },
  resolve: { tsconfigPaths: true },
});
