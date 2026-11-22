import { Kysely } from 'kysely';
import { randomBytes } from 'node:crypto';
import { SystemMetadataKey } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { OAuthAppRepository } from 'src/repositories/oauth-app.repository.js';
import { DB } from 'src/schema/index.js';
import { up as keepRegistrationOn } from 'src/schema/migrations/1794870000000-ConnectRegistrationDefault.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-752: the connected-apps threat model follow-ups that live in the queries. */
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

let db: Kysely<DB>;
let sut: OAuthAppRepository;
beforeAll(async () => {
  db = await getKyselyDB();
  sut = new OAuthAppRepository(db);
});

const newUser = async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { session } = await ctx.newSession({ userId: user.id });
  return { user, session };
};

const newClient = (createdAt = new Date()) =>
  db
    .insertInto('oauth_client')
    .values({ name: 'App', redirectUris: ['https://app.example/cb'], logoUri: null, dynamic: true, createdAt })
    .returning('id')
    .executeTakeFirstOrThrow();

const newGrant = (userId: string, clientId: string, values: { accessExpiresAt?: Date; revokedAt?: Date } = {}) =>
  sut.createGrant({
    userId,
    clientId,
    scopes: ['library:read'],
    resource: null,
    frameleafAccountId: null,
    refreshTokenHash: randomBytes(32),
    accessTokenHash: randomBytes(32),
    accessExpiresAt: values.accessExpiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
    revokedAt: values.revokedAt ?? null,
  });

const exists = async (table: 'oauth_client' | 'oauth_grant', id: string) =>
  !!(await db.selectFrom(table).select('id').where('id', '=', id).executeTakeFirst());

describe('createClient at the cap (FL-1636 TM-13)', () => {
  it('makes room only from apps nobody allowed for a week, and refuses when there are none', async () => {
    const { user } = await newUser();
    const pending = await newClient(daysAgo(2));
    const abandoned = await newClient(daysAgo(8));
    const allowed = await newClient(daysAgo(30));
    await newGrant(user.id, allowed.id);
    const { count } = await db
      .selectFrom('oauth_client')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('dynamic', '=', true)
      .executeTakeFirstOrThrow();
    const values = { name: 'New', redirectUris: ['https://new.example/cb'], logoUri: null, dynamic: true };

    // full: the week-old app nobody allowed makes room; the two-day-old one waiting for its Allow stays
    await expect(sut.createClient(values, Number(count), 7)).resolves.toBeDefined();
    await expect(exists('oauth_client', abandoned.id)).resolves.toBe(false);
    await expect(exists('oauth_client', pending.id)).resolves.toBe(true);

    // full again, and nothing is old enough: the new app is refused and nobody is pushed out
    await expect(sut.createClient(values, Number(count), 7)).resolves.toBeUndefined();
    await expect(exists('oauth_client', pending.id)).resolves.toBe(true);
    await expect(exists('oauth_client', allowed.id)).resolves.toBe(true);
  });
});

describe('a used code (FL-1635 TM-12)', () => {
  it('is taken once, and is then kept with what the grant it made has spent', async () => {
    const { user, session } = await newUser();
    const client = await newClient();
    const codeHash = randomBytes(32);
    await sut.createCode({
      codeHash,
      clientId: client.id,
      userId: user.id,
      sessionId: session.id,
      redirectUri: 'https://app.example/cb',
      codeChallenge: 'challenge',
      scopes: ['library:read'],
      resource: null,
      frameleafAccountId: null,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    await expect(sut.takeCode(codeHash)).resolves.toMatchObject({ clientId: client.id, userId: user.id });
    await expect(sut.takeCode(codeHash)).resolves.toBeUndefined();
    await expect(sut.getBySpentRefreshToken(codeHash)).resolves.toBeUndefined();

    const grant = await newGrant(user.id, client.id);
    await sut.keepSpentCode(codeHash, grant.id);
    await expect(sut.getBySpentRefreshToken(codeHash)).resolves.toMatchObject({ id: grant.id, clientName: 'App' });
  });
});

describe('purge (FL-1633 TM-9)', () => {
  it('ends idle grants and deletes revoked grants and spent tokens past the limit, keeping the rest', async () => {
    const { user } = await newUser();
    const client = await newClient();
    const active = await newGrant(user.id, client.id);
    const idle = await newGrant(user.id, client.id, { accessExpiresAt: daysAgo(91) });
    const resting = await newGrant(user.id, client.id, { accessExpiresAt: daysAgo(89) });
    const revokedLongAgo = await newGrant(user.id, client.id, { revokedAt: daysAgo(31) });
    const revokedLately = await newGrant(user.id, client.id, { revokedAt: daysAgo(29) });
    const oldToken = randomBytes(32);
    const newToken = randomBytes(32);
    await db
      .insertInto('oauth_spent_refresh_token')
      .values([
        { tokenHash: oldToken, grantId: active.id, spentAt: daysAgo(31) },
        { tokenHash: newToken, grantId: active.id, spentAt: daysAgo(29) },
      ])
      .execute();

    const result = await sut.purge({ idleBefore: daysAgo(90), purgeBefore: daysAgo(30) });

    expect(result).toMatchObject({ idle: 1, grants: 1, spentTokens: 1 });
    await expect(exists('oauth_grant', revokedLongAgo.id)).resolves.toBe(false);
    await expect(exists('oauth_grant', revokedLately.id)).resolves.toBe(true);
    await expect(sut.getByGrantId(idle.id)).resolves.toMatchObject({ revokedAt: expect.any(Date) });
    await expect(sut.getByGrantId(resting.id)).resolves.toMatchObject({ revokedAt: null });
    await expect(sut.getByGrantId(active.id)).resolves.toMatchObject({ revokedAt: null });
    await expect(sut.getBySpentRefreshToken(oldToken)).resolves.toBeUndefined();
    await expect(sut.getBySpentRefreshToken(newToken)).resolves.toMatchObject({ id: active.id });
  });
});

describe('upgrade to registration off by default (FL-1632 TM-8)', () => {
  const stored = async () =>
    (
      await db
        .selectFrom('system_metadata')
        .select('value')
        .where('key', '=', SystemMetadataKey.SystemConfig)
        .executeTakeFirst()
    )?.value as { connectedApps?: { allowRegistration?: boolean; allowMcp?: boolean }; trash?: unknown } | undefined;
  const store = async (value: object) => {
    await db.deleteFrom('system_metadata').where('key', '=', SystemMetadataKey.SystemConfig).execute();
    await db
      .insertInto('system_metadata')
      .values({ key: SystemMetadataKey.SystemConfig, value } as never)
      .execute();
  };

  it('keeps it on where an app already registered itself, unless the administrator chose', async () => {
    await newClient();

    await db.deleteFrom('system_metadata').where('key', '=', SystemMetadataKey.SystemConfig).execute();
    await keepRegistrationOn(db);
    await expect(stored()).resolves.toEqual({ connectedApps: { allowRegistration: true } });

    await store({ trash: { days: 7 }, connectedApps: { allowMcp: false } });
    await keepRegistrationOn(db);
    await expect(stored()).resolves.toEqual({
      trash: { days: 7 },
      connectedApps: { allowMcp: false, allowRegistration: true },
    });

    await store({ connectedApps: { allowRegistration: false } });
    await keepRegistrationOn(db);
    await expect(stored()).resolves.toEqual({ connectedApps: { allowRegistration: false } });
  });

  it('leaves a server where no app registered itself on the new default', async () => {
    await db.deleteFrom('oauth_client').execute();
    await db.deleteFrom('system_metadata').where('key', '=', SystemMetadataKey.SystemConfig).execute();
    await keepRegistrationOn(db);
    await expect(stored()).resolves.toBeUndefined();
  });
});
