import { Kysely, sql } from 'kysely';
import { getCatalogEvidence } from 'src/fork-schema/catalog.js';
import manifest from 'src/fork-schema/manifests/fork-v2-catalog.json' with { type: 'json' };
import * as migration from 'src/fork-schema/migrations/0000000000204-FrameleafUserLicenses.js';
import { FrameleafUserLicenseRepository } from 'src/repositories/frameleaf-user-license.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { newUuid } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-156: personal supporter keys, a fork-owned table. */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
  await sql`UPDATE immich_fork.state SET phase='dual-write' WHERE id=1`.execute(db);
});
afterAll(async () => {
  await db?.destroy();
});

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  return { ctx, sut: ctx.get(FrameleafUserLicenseRepository) };
};

const isUserLicense = (entry: { identity: string }) => entry.identity.startsWith('immich_fork.frameleaf_user_license');

const row = (userId: string, keySha256: string) => ({
  userId,
  keyHint: '8ELH',
  keySha256,
  binding: 'b'.repeat(64),
  certificate: 'header.payload.signature',
  activationId: 'act-1',
});

it('matches the private catalog and rolls back without modifying the official catalog', async () => {
  const before = await getCatalogEvidence(db);
  for (const kind of ['tables', 'columns', 'constraints', 'indexes'] as const) {
    expect(before[kind].filter((entry) => isUserLicense(entry))).toEqual(
      manifest[kind].filter((entry) => isUserLicense(entry)),
    );
  }
  await migration.down(db);
  await migration.up(db);
  const after = await getCatalogEvidence(db);
  for (const kind of ['tables', 'columns', 'constraints', 'indexes', 'functions', 'triggers'] as const) {
    expect(after[kind].filter((entry) => entry.identity.startsWith('public.'))).toEqual(
      before[kind].filter((entry) => entry.identity.startsWith('public.')),
    );
  }
});

it('keeps one key per account and one account per key, and replaces an account’s key', async () => {
  const { ctx, sut } = setup();
  const { user } = await ctx.newUser();
  const { user: other } = await ctx.newUser();
  const hash = newUuid().replaceAll('-', '');

  const first = await sut.upsert(row(user.id, hash));
  expect(first).toMatchObject({ userId: user.id, kind: 'individual', keyHint: '8ELH' });
  await expect(sut.get(user.id)).resolves.toMatchObject({ keySha256: hash });
  await expect(sut.getByKeyHash(hash)).resolves.toMatchObject({ userId: user.id });

  await expect(sut.upsert(row(other.id, hash))).rejects.toThrow();

  const replacement = newUuid().replaceAll('-', '');
  await sut.upsert({ ...row(user.id, replacement), keyHint: 'CMSF' });
  await expect(sut.get(user.id)).resolves.toMatchObject({ keySha256: replacement, keyHint: 'CMSF' });
  await expect(sut.getByKeyHash(hash)).resolves.toBeUndefined();

  await sut.delete(user.id);
  await expect(sut.get(user.id)).resolves.toBeUndefined();
});

it('refuses a key hint that is not four symbols', async () => {
  const { ctx, sut } = setup();
  const { user } = await ctx.newUser();
  await expect(sut.upsert({ ...row(user.id, newUuid()), keyHint: 'TOO-LONG' })).rejects.toThrow();
});
