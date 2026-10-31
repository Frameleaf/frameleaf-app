import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { DatabaseLock, SystemMetadataKey } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { FrameleafAccountRepository } from 'src/repositories/frameleaf-account.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { OAuthRepository } from 'src/repositories/oauth.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { FrameleafAuthService } from 'src/services/frameleaf-auth.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db.destroy();
});
afterEach(() => vi.restoreAllMocks());

const config = { issuerUrl: 'https://id.cloud.test', clientId: 'instance', scope: 'openid email profile' };
const details = { isSecure: true, clientIp: '127.0.0.1', deviceOS: '', deviceType: '', appVersion: null };

it.each(['callback', 'exchange'] as const)(
  '%s rejects a committed Cloud generation replacement during issuer verification',
  async (flow) => {
    const h = await setup(flow);
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    h.verify.mockImplementationOnce(async () => {
      entered.resolve();
      await resume.promise;
      return h.verified;
    });
    const operation = h.submit();
    const refused = expect(operation).rejects.toMatchObject({ status: flow === 'callback' ? 401 : 403 });
    try {
      await entered.promise;
      await h.ctx
        .get(DatabaseRepository)
        .withLock(DatabaseLock.FrameleafLinkAuthority, () =>
          h.metadata.set(SystemMetadataKey.FrameleafCloudLink, { ...h.link, linkedAt: 'replacement-generation' }),
        );
      resume.resolve();
      await refused;
      expect(await h.sessions.getByUserId(h.user.id)).toHaveLength(0);
      expect(await h.accounts.findSessions({ sub: h.profile.sub })).toHaveLength(0);
      expect((await h.accounts.getLinkBySub(h.profile.sub))?.lastSignInAt).toBeNull();
    } finally {
      resume.resolve();
      await Promise.allSettled([operation, refused]);
      await h.restore();
    }
  },
);

it.each(['callback', 'exchange'] as const)(
  '%s holds the Cloud fence through tagging and removes a child missed by logout',
  async (flow) => {
    const h = await setup(flow);
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const tag = h.accounts.tagSession.bind(h.accounts);
    let childId: string | undefined;
    vi.spyOn(h.accounts, 'tagSession').mockImplementation(async (row) => {
      childId = row.sessionId;
      entered.resolve();
      await resume.promise;
      return tag(row);
    });
    const operation = h.submit();
    const refused = expect(operation).rejects.toMatchObject({ status: flow === 'callback' ? 401 : 403 });
    try {
      await entered.promise;
      const acquired = await db.transaction().execute(async (tx) => {
        const { rows } = await sql<{
          acquired: boolean;
        }>`select pg_try_advisory_xact_lock(${DatabaseLock.FrameleafLinkAuthority}::bigint) as acquired`.execute(tx);
        return rows[0].acquired;
      });
      expect(acquired).toBe(false);
      await h.accounts.revokeSignIns({ sub: h.profile.sub, sid: h.profile.sid }, new Date(Date.now() + 120_000));
      expect(await h.accounts.findSessions({ sub: h.profile.sub })).toHaveLength(0);
      resume.resolve();
      await refused;
      expect(await h.sessions.get(childId!)).toBeUndefined();
      expect(await h.accounts.getSession(childId!)).toBeUndefined();
    } finally {
      resume.resolve();
      await Promise.allSettled([operation, refused]);
      await h.restore();
    }
  },
);

it.each(['callback', 'exchange'] as const)(
  '%s leaves Cloud authority available while setup holds the claim lock',
  async (flow) => {
    const h = await setup(flow);
    const entered = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>();
    const holder = db.connection().execute(async (connection) => {
      await sql`select pg_advisory_lock(${DatabaseLock.FrameleafServerClaim}::bigint)`.execute(connection);
      try {
        entered.resolve();
        await resume.promise;
      } finally {
        await sql`select pg_advisory_unlock(${DatabaseLock.FrameleafServerClaim}::bigint)`.execute(connection);
      }
    });
    await entered.promise;
    const requested = Promise.withResolvers<void>();
    const database = h.ctx.get(DatabaseRepository),
      withLock = database.withLock.bind(database);
    vi.spyOn(database, 'withLock').mockImplementation((lock, callback) => {
      if (lock === DatabaseLock.FrameleafServerClaim) requested.resolve();
      return withLock(lock, callback);
    });
    const operation = h.submit();
    try {
      await Promise.race([
        requested.promise,
        operation.then(() => {
          throw new Error('Sign-in bypassed the setup claim fence');
        }),
      ]);
      const acquired = await db.transaction().execute(async (tx) => {
        const { rows } = await sql<{
          acquired: boolean;
        }>`select pg_try_advisory_xact_lock(${DatabaseLock.FrameleafLinkAuthority}::bigint) as acquired`.execute(tx);
        return rows[0].acquired;
      });
      expect(acquired).toBe(true);
      resume.resolve();
      await holder;
      await expect(operation).resolves.toMatchObject({ userId: h.user.id });
    } finally {
      resume.resolve();
      await Promise.allSettled([holder, operation]);
      await h.restore();
    }
  },
);

const setup = async (flow: 'callback' | 'exchange') => {
  const env = mockEnvData({});
  const { sut, ctx } = newMediumService(FrameleafAuthService, {
    database: db,
    real: [
      CryptoRepository,
      DatabaseRepository,
      FrameleafAccountRepository,
      SessionRepository,
      SystemMetadataRepository,
      UserRepository,
    ],
    mock: [ConfigRepository, EventRepository, LoggingRepository, OAuthRepository],
  });
  ctx.getMock(ConfigRepository).getEnv.mockReturnValue({
    ...env,
    frameleafCloud: { ...env.frameleafCloud, url: 'https://cloud.test' },
  });
  ctx.getMock(EventRepository).emit.mockResolvedValue();
  await ctx.newUser({ isAdmin: true });
  const { result: user } = await ctx.newUser({ isAdmin: false });
  const accounts = ctx.get(FrameleafAccountRepository);
  const sessions = ctx.get(SessionRepository);
  const metadata = ctx.get(SystemMetadataRepository);
  const previous = await metadata.get(SystemMetadataKey.FrameleafCloudLink);
  const link = {
    status: 'linked' as const,
    cloudUrl: 'https://cloud.test',
    instanceId: 'instance',
    linkedAt: new Date().toISOString(),
    oidc: {
      issuer: config.issuerUrl,
      clientId: config.clientId,
      scope: config.scope,
      roleClaim: 'frameleaf_role',
      storageLabelClaim: '',
    },
  };
  await metadata.set(SystemMetadataKey.FrameleafCloudLink, link);
  const now = Math.floor(Date.now() / 1000);
  const profile = {
    sub: randomUUID(),
    sid: randomUUID(),
    jti: randomUUID(),
    iat: now,
    exp: now + 120,
    email: user.email,
    email_verified: true,
    frameleaf_role: 'user',
    frameleaf_access: 'viewer',
  };
  await accounts.upsertLink({
    userId: user.id,
    sub: profile.sub,
    email: user.email,
    emailVerified: true,
    role: 'user',
    autoRegistered: false,
  });
  const internals = sut as unknown as { config: () => Promise<unknown>; exchange: () => Promise<unknown> };
  vi.spyOn(internals, 'config').mockResolvedValue(config);
  const verified = flow === 'callback' ? { profile, sid: profile.sid, idToken: 'synthetic' } : profile;
  const verify = flow === 'callback' ? vi.spyOn(internals, 'exchange') : ctx.getMock(OAuthRepository).verifyClientToken;
  verify.mockResolvedValue(verified as never);
  const submit = () =>
    flow === 'callback'
      ? sut.callback(
          { url: 'https://photos.test/auth/login?code=synthetic', state: 'state', codeVerifier: 'verifier' },
          {},
          details,
        )
      : sut.exchangeToken({ token: 'synthetic' }, details);
  const restore = async () => {
    if (previous) await metadata.set(SystemMetadataKey.FrameleafCloudLink, previous);
    else await db.deleteFrom('system_metadata').where('key', '=', SystemMetadataKey.FrameleafCloudLink).execute();
  };
  return { ctx, accounts, sessions, metadata, link, user, profile, verify, verified, submit, restore };
};
