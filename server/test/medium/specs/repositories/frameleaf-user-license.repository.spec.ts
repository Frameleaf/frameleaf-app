import { Kysely } from 'kysely';
import { FrameleafUserLicenseRepository } from 'src/repositories/frameleaf-user-license.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { expectCanonicalTables } from 'test/fixtures/canonical-database.js';
import { newMediumService } from 'test/medium.factory.js';
import { newUuid } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-156: personal supporter keys, a fork-owned table. */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  return { ctx, sut: ctx.get(FrameleafUserLicenseRepository) };
};

const row = (userId: string, keySha256: string) => ({
  userId,
  keyHint: '8ELH',
  keySha256,
  binding: 'b'.repeat(64),
  certificate: 'header.payload.signature',
  activationId: 'act-1',
});

it('installs feature tables in the real canonical baseline', async () => {
  await expectCanonicalTables(db, ['frameleaf_user_license']);
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
