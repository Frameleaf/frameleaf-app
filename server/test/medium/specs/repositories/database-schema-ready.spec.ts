import { Kysely, sql } from 'kysely';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

class Rollback extends Error {}

/** The edge worker waits on this before it reads anything (a fresh install is still migrating). */
describe('DatabaseRepository.isSchemaReady', () => {
  it('is ready once the canonical Frameleaf baseline has run', async () => {
    const sut = new DatabaseRepository(defaultDatabase, LoggingRepository.create(), new ConfigRepository());
    await expect(sut.isSchemaReady()).resolves.toBe(true);
  });

  for (const [what, table] of [
    ['public', 'public.system_metadata'],
    ['migration ledger', 'public.frameleaf_migrations'],
  ] as const) {
    it(`is not ready while the ${what} schema is missing`, async () => {
      const result = defaultDatabase.transaction().execute(async (trx) => {
        await sql.raw(`ALTER TABLE ${table} RENAME TO schema_ready_moved`).execute(trx);
        const sut = new DatabaseRepository(trx, LoggingRepository.create(), new ConfigRepository());
        await expect(sut.isSchemaReady()).resolves.toBe(false);
        throw new Rollback();
      });
      await expect(result).rejects.toBeInstanceOf(Rollback);
    });
  }
});
