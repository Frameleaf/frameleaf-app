import { Kysely } from 'kysely';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { hashRecoveryCode } from 'src/utils/two-factor.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-793: two-step sign-in storage: setup, switch-on, each code step once, recovery codes once. */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});

const setup = async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  return { sut: new UserRepository(db), userId: user.id };
};

it('replaces an unfinished setup but never one that is on', async () => {
  const { sut, userId } = await setup();
  await expect(sut.setPendingTwoFactor(userId, 'sealed-1')).resolves.toEqual({ userId });
  await expect(sut.setPendingTwoFactor(userId, 'sealed-2')).resolves.toEqual({ userId });
  await expect(sut.getTwoFactor(userId)).resolves.toEqual({
    userId,
    secret: 'sealed-2',
    enabledAt: null,
    pendingSecret: null,
  });

  await expect(sut.enableTwoFactor(userId, 100, [hashRecoveryCode('a')])).resolves.toBe(true);
  await expect(sut.enableTwoFactor(userId, 101, [])).resolves.toBe(false);
  await expect(sut.setPendingTwoFactor(userId, 'sealed-3')).resolves.toBeUndefined();
  const row = await sut.getTwoFactor(userId);
  expect(row?.secret).toBe('sealed-2');
  expect(row?.enabledAt).toBeInstanceOf(Date);
});

it('accepts each time step once, and only steps after the last one', async () => {
  const { sut, userId } = await setup();
  await sut.setPendingTwoFactor(userId, 'sealed');
  await sut.enableTwoFactor(userId, 1_000, []);

  await expect(sut.useTwoFactorStep(userId, 1_000)).resolves.toBe(false);
  await expect(sut.useTwoFactorStep(userId, 999)).resolves.toBe(false);
  const results = await Promise.all([sut.useTwoFactorStep(userId, 1_001), sut.useTwoFactorStep(userId, 1_001)]);
  expect(results.filter(Boolean)).toHaveLength(1);
});

it('spends a recovery code once, counts what is left, and drops everything when turned off', async () => {
  const { sut, userId } = await setup();
  await sut.setPendingTwoFactor(userId, 'sealed');
  await sut.enableTwoFactor(
    userId,
    1,
    ['a', 'b', 'c'].map((code) => hashRecoveryCode(code)),
  );
  await expect(sut.countRecoveryCodes(userId)).resolves.toBe(3);

  await expect(sut.useRecoveryCode(userId, hashRecoveryCode('b'))).resolves.toBe(true);
  await expect(sut.useRecoveryCode(userId, hashRecoveryCode('b'))).resolves.toBe(false);
  await expect(sut.useRecoveryCode(userId, hashRecoveryCode('z'))).resolves.toBe(false);
  await expect(sut.countRecoveryCodes(userId)).resolves.toBe(2);

  await sut.replaceRecoveryCodes(userId, [hashRecoveryCode('new')]);
  await expect(sut.useRecoveryCode(userId, hashRecoveryCode('a'))).resolves.toBe(false);
  await expect(sut.countRecoveryCodes(userId)).resolves.toBe(1);

  await expect(sut.deleteTwoFactor(userId)).resolves.toBe(true);
  await expect(sut.getTwoFactor(userId)).resolves.toBeUndefined();
  await expect(sut.countRecoveryCodes(userId)).resolves.toBe(0);
  await expect(sut.deleteTwoFactor(userId)).resolves.toBe(false);
});

it('moves to a new key only while on, and only the pending key that was checked', async () => {
  const { sut, userId } = await setup();
  await sut.setPendingTwoFactor(userId, 'old');
  await expect(sut.setPendingTwoFactorMove(userId, 'new-1')).resolves.toBe(false);
  await sut.enableTwoFactor(userId, 10, [hashRecoveryCode('kept')]);

  await expect(sut.setPendingTwoFactorMove(userId, 'new-1')).resolves.toBe(true);
  await expect(sut.setPendingTwoFactorMove(userId, 'new-2')).resolves.toBe(true);
  await expect(sut.confirmTwoFactorMove(userId, 20, 'new-1')).resolves.toBe(false);
  await expect(sut.getTwoFactor(userId)).resolves.toMatchObject({ secret: 'old', pendingSecret: 'new-2' });

  const before = (await sut.getTwoFactor(userId))?.enabledAt;
  await expect(sut.confirmTwoFactorMove(userId, 20, 'new-2')).resolves.toBe(true);
  const after = await sut.getTwoFactor(userId);
  expect(after).toMatchObject({ secret: 'new-2', pendingSecret: null });
  expect(after?.enabledAt).toEqual(before);
  await expect(sut.useTwoFactorStep(userId, 20)).resolves.toBe(false);
  await expect(sut.countRecoveryCodes(userId)).resolves.toBe(1);
});
