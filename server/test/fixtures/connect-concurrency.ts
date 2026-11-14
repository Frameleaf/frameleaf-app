import { Kysely, sql } from 'kysely';
import type { DB } from 'src/schema/index.js';
import { getKyselyConfig } from 'src/utils/database.js';

/** A separate pool is essential: publication holds the first connection until the competing writer finishes. */
export const connectCompetitor = async (database: Kysely<DB>) => {
  const {
    rows: [{ name }],
  } = await sql<{ name: string }>`select current_database() name`.execute(database);
  const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
  url.pathname = `/${name}`;
  return new Kysely<DB>(getKyselyConfig({ connectionType: 'url', url: url.href }));
};

export const publicationBarrier = () => {
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  const { promise: ready, resolve: checked } = Promise.withResolvers<void>();
  return {
    ready,
    release,
    hold: async () => {
      checked();
      await held;
    },
  };
};
