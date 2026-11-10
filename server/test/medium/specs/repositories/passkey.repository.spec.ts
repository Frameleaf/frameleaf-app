import { Kysely } from 'kysely';
import { randomBytes } from 'node:crypto';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PasskeyRepository } from 'src/repositories/passkey.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-836: passkey storage: one credential once, counters that only move on, challenges used once. */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});

const setup = async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { session } = await ctx.newSession({ userId: user.id });
  return { ctx, sut: new PasskeyRepository(db), userId: user.id, sessionId: session.id };
};

const passkey = (userId: string, name = 'Chrome on Mac') => ({
  userId,
  credentialId: randomBytes(16),
  publicKey: randomBytes(77),
  name,
  rpId: 'photos.example.com',
  transports: ['internal'],
});

const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000);

it('saves a credential once, for one account only', async () => {
  const { ctx, sut, userId } = await setup();
  const { user: other } = await ctx.newUser();
  const row = passkey(userId);

  const saved = await sut.create(row);
  expect(saved).toMatchObject({
    userId,
    name: 'Chrome on Mac',
    counter: 0,
    transports: ['internal'],
    backedUp: false,
  });
  await expect(sut.create({ ...row, userId: other.id })).resolves.toBeUndefined();
  await expect(sut.getByCredentialId(row.credentialId)).resolves.toMatchObject({ id: saved!.id, userId });
  await expect(sut.countByUser(userId)).resolves.toBe(1);
  await expect(sut.countByUser(other.id)).resolves.toBe(0);
});

it('moves the counter on only from the value just checked', async () => {
  const { sut, userId } = await setup();
  const saved = (await sut.create(passkey(userId)))!;

  const results = await Promise.all([sut.recordUse(saved.id, 0, 1, true), sut.recordUse(saved.id, 0, 1, true)]);
  expect(results.filter(Boolean)).toHaveLength(1);
  await expect(sut.recordUse(saved.id, 0, 2, true)).resolves.toBe(false);
  const [row] = await sut.getByUser(userId);
  expect(row).toMatchObject({ counter: 1, backedUp: true });
  expect(row.lastUsedAt).toBeInstanceOf(Date);
});

it('renames and removes only the account’s own passkeys, signing out the sessions they started', async () => {
  const { ctx, sut, userId, sessionId } = await setup();
  const { user: other } = await ctx.newUser();
  const saved = (await sut.create(passkey(userId)))!;
  const { session: started } = await ctx.newSession({ userId });
  await sut.linkSession(started.id, saved.id);
  await expect(sut.isPasskeySession(started.id)).resolves.toBe(true);
  await expect(sut.isPasskeySession(sessionId)).resolves.toBe(false);

  await expect(sut.rename(other.id, saved.id, 'Mine')).resolves.toBeUndefined();
  await expect(sut.rename(userId, saved.id, 'Work laptop')).resolves.toMatchObject({ name: 'Work laptop' });

  await expect(sut.delete(other.id, saved.id)).resolves.toBeUndefined();
  // the session removing it is kept
  const { session: removing } = await ctx.newSession({ userId });
  await sut.linkSession(removing.id, saved.id);
  await expect(sut.delete(userId, saved.id, removing.id)).resolves.toEqual({
    name: 'Work laptop',
    count: 1,
    sessionIds: [started.id],
  });
  // the session that removed it still counts as a passkey sign-in (remote access keeps working there)
  await expect(sut.isPasskeySession(removing.id)).resolves.toBe(true);
  // a sign-in racing the removal gets no link, so it is signed out
  const { session: late } = await ctx.newSession({ userId });
  await expect(sut.linkSession(late.id, saved.id)).resolves.toBe(false);
  await db.deleteFrom('session').where('id', '=', late.id).execute();
  const sessions = await db.selectFrom('session').select('id').where('userId', '=', userId).execute();
  expect(sessions.map(({ id }) => id).toSorted()).toEqual([sessionId, removing.id].toSorted());
  await expect(sut.getByUser(userId)).resolves.toEqual([]);
});

it('removes every passkey of an account and the sessions they started', async () => {
  const { ctx, sut, userId } = await setup();
  const first = (await sut.create(passkey(userId, 'One')))!;
  await sut.create(passkey(userId, 'Two'));
  const { session } = await ctx.newSession({ userId });
  await sut.linkSession(session.id, first.id);

  await expect(sut.deleteAll(userId)).resolves.toEqual({ count: 2, sessionIds: [session.id] });
  await expect(sut.countByUser(userId)).resolves.toBe(0);
  await expect(sut.deleteAll(userId)).resolves.toEqual({ count: 0, sessionIds: [] });
});

it('answers a challenge once, and never after it expired', async () => {
  const { sut, userId, sessionId } = await setup();
  await sut.createChallenge({
    purpose: 'register',
    challenge: 'challenge-1',
    userId,
    sessionId,
    origin: 'https://photos.example.com',
    rpId: 'photos.example.com',
    expiresAt: inMinutes(5),
  });
  await sut.createChallenge({ purpose: 'login', challenge: 'challenge-2', expiresAt: inMinutes(-1) });

  await expect(sut.takeChallenge('login', 'challenge-1')).resolves.toBeUndefined();
  await expect(sut.takeChallenge('register', 'challenge-1')).resolves.toEqual({
    userId,
    sessionId,
    origin: 'https://photos.example.com',
    rpId: 'photos.example.com',
  });
  await expect(sut.takeChallenge('register', 'challenge-1')).resolves.toBeUndefined();
  await expect(sut.takeChallenge('login', 'challenge-2')).resolves.toBeUndefined();
});

it('forgets pending registrations and password checks, but not sign-in challenges', async () => {
  const { sut, userId, sessionId } = await setup();
  await sut.createChallenge({ purpose: 'register', challenge: 'reg-1', userId, sessionId, expiresAt: inMinutes(5) });
  await sut.createChallenge({
    purpose: 'password-proof',
    challenge: 'proof-x',
    userId,
    sessionId,
    expiresAt: inMinutes(10),
  });
  await sut.createChallenge({ purpose: 'login', challenge: 'login-1', expiresAt: inMinutes(5) });

  await sut.deletePendingRegistrations(userId);
  await expect(sut.takeChallenge('register', 'reg-1')).resolves.toBeUndefined();
  await expect(sut.hasPasswordProof(sessionId)).resolves.toBe(false);
  await expect(sut.takeChallenge('login', 'login-1')).resolves.toMatchObject({ userId: null });
});

it('keeps a password check for its session until it expires', async () => {
  const { ctx, sut, userId, sessionId } = await setup();
  const { session: other } = await ctx.newSession({ userId });
  await expect(sut.hasPasswordProof(sessionId)).resolves.toBe(false);

  await sut.createChallenge({
    purpose: 'password-proof',
    challenge: 'proof-1',
    userId,
    sessionId,
    expiresAt: inMinutes(10),
  });
  await expect(sut.hasPasswordProof(sessionId)).resolves.toBe(true);
  await expect(sut.hasPasswordProof(other.id)).resolves.toBe(false);

  await sut.createChallenge({
    purpose: 'password-proof',
    challenge: 'proof-2',
    userId,
    sessionId: other.id,
    expiresAt: inMinutes(-1),
  });
  await expect(sut.hasPasswordProof(other.id)).resolves.toBe(false);
});
