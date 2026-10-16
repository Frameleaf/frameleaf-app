import { Kysely } from 'kysely';
import { UserMetadataKey } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});

it('creates exactly one partner Locked notice for concurrent first copies', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [UserRepository], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const repository = new UserRepository(db);
  const results = await Promise.all(Array.from({ length: 10 }, () => repository.insertPartnerLockedNotice(user.id)));
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(
    (await repository.getMetadata(user.id)).filter(({ key }) => key === UserMetadataKey.PartnerLockedNotice),
  ).toEqual([
    { key: UserMetadataKey.PartnerLockedNotice, value: { flaggedAt: expect.any(String), dismissedAt: null } },
  ]);
});

it('never overwrites the original partner Locked notice or its dismissal on a late insert', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [UserRepository], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const repository = new UserRepository(db);
  const value = { flaggedAt: '2026-10-01T00:00:00.000Z', dismissedAt: '2026-10-02T00:00:00.000Z' };
  await repository.upsertMetadata(user.id, { key: UserMetadataKey.PartnerLockedNotice, value });
  const results = await Promise.all(Array.from({ length: 10 }, () => repository.insertPartnerLockedNotice(user.id)));
  expect(results).toEqual(Array(10).fill(false));
  expect(
    (await repository.getMetadata(user.id)).find(({ key }) => key === UserMetadataKey.PartnerLockedNotice)?.value,
  ).toEqual(value);
});
