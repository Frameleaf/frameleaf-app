import { Kysely } from 'kysely';
import { createHash } from 'node:crypto';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-538: a "choose a password" link works once, only while it has not expired. */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});

const digest = (token: string) => createHash('sha256').update(token).digest();

it('finds and uses a link once, and never one that has expired', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const sut = new UserRepository(db);
  const { user } = await ctx.newUser();
  const { user: other } = await ctx.newUser();

  await sut.update(user.id, {
    passwordLinkHash: digest('fresh'),
    passwordLinkExpiresAt: new Date(Date.now() + 60_000),
  });
  await sut.update(other.id, {
    passwordLinkHash: digest('stale'),
    passwordLinkExpiresAt: new Date(Date.now() - 60_000),
  });

  await expect(sut.getByPasswordLink(digest('fresh'))).resolves.toEqual({
    id: user.id,
    name: user.name,
    email: user.email,
  });
  await expect(sut.getByPasswordLink(digest('stale'))).resolves.toBeUndefined();
  await expect(sut.redeemPasswordLink(digest('stale'), 'hash')).resolves.toBeUndefined();

  await expect(sut.redeemPasswordLink(digest('fresh'), 'new-hash')).resolves.toEqual({
    id: user.id,
    email: user.email,
  });
  const row = await db
    .selectFrom('user')
    .select(['password', 'shouldChangePassword', 'passwordLinkHash', 'passwordLinkExpiresAt'])
    .where('id', '=', user.id)
    .executeTakeFirstOrThrow();
  expect(row).toEqual({
    password: 'new-hash',
    shouldChangePassword: false,
    passwordLinkHash: null,
    passwordLinkExpiresAt: null,
  });

  // used once: the same link finds nothing again
  await expect(sut.redeemPasswordLink(digest('fresh'), 'again')).resolves.toBeUndefined();
});

it('starts every account with new uploads allowed', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const sut = new UserRepository(db);
  await expect(sut.get(user.id, {})).resolves.toEqual(expect.objectContaining({ uploadsPaused: false }));
  await sut.update(user.id, { uploadsPaused: true });
  await expect(sut.get(user.id, {})).resolves.toEqual(expect.objectContaining({ uploadsPaused: true }));
});
