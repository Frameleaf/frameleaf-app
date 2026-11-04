import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { type DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

it('keeps activation evidence and phase atomic, with paired object/hash constraints', async () => {
  const operation = randomUUID();
  // Database-constraint fixture only; neither this binding nor this payload is an admitted activation proof.
  await sql`INSERT INTO frameleaf_library_import(operation_id,binding,status)
    VALUES(${operation}::uuid,${JSON.stringify({ operationId: operation })}::text::jsonb,'verifying')`.execute(db);
  expect((await sql`SELECT activation,activation_sha256 FROM frameleaf_library_import`.execute(db)).rows).toEqual([
    { activation: null, activation_sha256: null },
  ]);
  const payload = JSON.stringify({ fixture: 'schema-only' });
  const checksum = 'a'.repeat(64);
  await expect(
    db.transaction().execute(async (tx) => {
      await sql`UPDATE frameleaf_library_import SET status='activated',activation=${payload}::text::jsonb,
      activation_sha256=${checksum}`.execute(tx);
      throw new Error('synthetic interrupted activation');
    }),
  ).rejects.toThrow('synthetic interrupted activation');
  expect(
    (await sql`SELECT status,activation,activation_sha256 FROM frameleaf_library_import`.execute(db)).rows,
  ).toEqual([{ status: 'verifying', activation: null, activation_sha256: null }]);
  for (const [phase, value, hash] of [
    ['verifying', payload, checksum],
    ['activated', payload, null],
    ['activated', '[]', checksum],
    ['activated', payload, 'invalid'],
  ]) {
    await expect(
      db.transaction().execute(async (tx) => {
        await sql`UPDATE frameleaf_library_import SET status=${phase},activation=${value}::text::jsonb,
        activation_sha256=${hash}`.execute(tx);
      }),
    ).rejects.toThrow();
  }
  await sql`UPDATE frameleaf_library_import SET status='activated',activation=${payload}::text::jsonb,
    activation_sha256=${checksum}`.execute(db);
  expect((await sql`SELECT status,activation_sha256 FROM frameleaf_library_import`.execute(db)).rows).toEqual([
    { status: 'activated', activation_sha256: checksum },
  ]);
});
