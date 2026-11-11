import { Kysely } from 'kysely';
import { randomBytes } from 'node:crypto';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** Unified sign-in: a session and how it was made are written together and removed together. */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});

it('writes the session and its sign-in record in one go, and removes them together', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const sut = new SessionRepository(db);

  const token = randomBytes(32);
  const session = await sut.create({ token, userId: user.id }, undefined, {
    methods: ['pwd', 'totp'],
    level: 'verified',
    source: 'local',
    legacy: false,
  });
  await expect(sut.getSignIn(session.id)).resolves.toMatchObject({
    methods: ['pwd', 'totp'],
    level: 'verified',
    source: 'local',
    legacy: false,
  });

  // the request path reads it with the session, in one query
  const found = await sut.getByToken(token);
  expect(found?.signIn).toMatchObject({ methods: ['pwd', 'totp'], level: 'verified', source: 'local', legacy: false });

  await sut.raiseSignIn(session.id, 'recovery_code');
  await expect(sut.getSignIn(session.id)).resolves.toMatchObject({
    methods: ['pwd', 'totp', 'recovery_code'],
    level: 'verified',
  });

  await db.deleteFrom('session').where('id', '=', session.id).execute();
  await expect(sut.getSignIn(session.id)).resolves.toBeUndefined();
});

it('leaves no session behind when the record cannot be written', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const sut = new SessionRepository(db);
  const token = randomBytes(32);

  await expect(
    sut.create({ token, userId: user.id }, undefined, { methods: [], level: 'basic', source: null as never }),
  ).rejects.toThrow();
  await expect(db.selectFrom('session').select('id').where('token', '=', token).execute()).resolves.toEqual([]);
});
