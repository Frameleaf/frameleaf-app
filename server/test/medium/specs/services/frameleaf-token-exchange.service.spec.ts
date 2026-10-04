import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { FrameleafTokenExchangeErrorCode } from 'src/dtos/frameleaf-auth.dto.js';
import { SystemMetadataKey } from 'src/enum.js';
import { AdminAuditRepository } from 'src/repositories/admin-audit.repository.js';
import { ClusterGroupRepository } from 'src/repositories/cluster-group.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { FrameleafAccountRepository } from 'src/repositories/frameleaf-account.repository.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { OAuthRepository } from 'src/repositories/oauth.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { AuthService } from 'src/services/auth.service.js';
import { BaseService } from 'src/services/base.service.js';
import { FrameleafAuthService } from 'src/services/frameleaf-auth.service.js';
import { FrameleafCloudService } from 'src/services/frameleaf-cloud.service.js';
import { FakeCloud, startFakeCloud } from 'test/fake-frameleaf-cloud.js';
import { mintExchangeToken } from 'test/fixtures/frameleaf-token-exchange.js';
import { MediumTestContext, newMediumService } from 'test/medium.factory.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-230 (NAPI-006) against the database: a session from `POST oauth/frameleaf/exchange` is a
 * Sign in with Frameleaf session, so a back-channel logout, unlinking the Frameleaf account,
 * Frameleaf Cloud removing access and unlinking the server end it like a browser one. Tokens are
 * contract fixtures signed with a test issuer key, as in the Sign in with Frameleaf unit tests.
 */
const INSTANCE = 'instance-fl230';
const loginDetails = { isSecure: true, clientIp: '127.0.0.1', deviceOS: 'iOS', deviceType: 'iPhone', appVersion: null };

let db: Kysely<DB>;
let cloud: FakeCloud;
let issuerKey: CryptoKey;

const issuer = () => `${cloud.url}/id`;

beforeAll(async () => {
  db = await getKyselyDB();

  const pair = await generateKeyPair('RS256', { extractable: true });
  issuerKey = pair.privateKey;
  const issuerJwk = await exportJWK(pair.publicKey);
  cloud = await startFakeCloud();
  cloud.on('GET /id/.well-known/openid-configuration', () => ({
    status: 200,
    body: {
      issuer: issuer(),
      authorization_endpoint: `${issuer()}/auth`,
      token_endpoint: `${issuer()}/token`,
      jwks_uri: `${issuer()}/jwks`,
      response_types_supported: ['code'],
      id_token_signing_alg_values_supported: ['RS256'],
    },
  }));
  cloud.on('GET /id/jwks', () => ({ status: 200, body: { keys: [{ ...issuerJwk, kid: 'issuer-1', alg: 'RS256' }] } }));
});

afterAll(async () => {
  await cloud?.close();
  await db?.destroy();
});

const oauth = new OAuthRepository(LoggingRepository.create());

const setup = <S extends typeof BaseService>(Service: S) => {
  const { sut, ctx } = newMediumService(Service, {
    database: db,
    real: [
      AdminAuditRepository,
      ClusterGroupRepository,
      CryptoRepository,
      DatabaseRepository,
      FrameleafAccountRepository,
      SessionRepository,
      SystemMetadataRepository,
      UserRepository,
    ],
    mock: [
      ConfigRepository,
      EventRepository,
      FrameleafCloudRepository,
      InstanceIdentityRepository,
      LoggingRepository,
      OAuthRepository,
      WebsocketRepository,
    ],
  });
  const env = mockEnvData({});
  ctx.getMock(ConfigRepository).getEnv.mockReturnValue({
    ...env,
    frameleafCloud: { ...env.frameleafCloud, url: cloud.url, identityDir: '/unused' },
  } as never);
  ctx.getMock(EventRepository).emit.mockResolvedValue();
  ctx
    .getMock(InstanceIdentityRepository)
    .loadOrCreate.mockResolvedValue({ instanceId: INSTANCE, kid: 'kid-1' } as never);
  // the real verification against the fake issuer's JWKS
  const mocked = ctx.getMock(OAuthRepository);
  mocked.verifyClientToken.mockImplementation((...args) => oauth.verifyClientToken(...args));
  mocked.validateLogoutToken.mockImplementation((...args) => oauth.validateLogoutToken(...args));
  return { sut, ctx: ctx as MediumTestContext };
};

const link = async (ctx: MediumTestContext) => {
  // FL-292: a server that is already set up (it has an administrator), so sign-ins are not claims
  await ctx.newUser({ isAdmin: true });
  await ctx.get(SystemMetadataRepository).set(SystemMetadataKey.FrameleafCloudLink, {
    status: 'linked',
    cloudUrl: cloud.url,
    instanceId: INSTANCE,
    oidc: { issuer: issuer(), clientId: INSTANCE, scope: 'openid email profile', roleClaim: 'frameleaf_role' },
  } as never);
};

/** A person here with a Frameleaf account, and tokens the identity provider mints for them. */
const person = async (ctx: MediumTestContext) => {
  const sub = `sub-${randomUUID()}`;
  const email = `${randomUUID()}@example.test`;
  const { user } = await ctx.newUser({ email });
  const mint = (claims: Record<string, unknown> = {}, issuedAt?: number) =>
    mintExchangeToken({
      key: issuerKey,
      kid: 'issuer-1',
      alg: 'RS256',
      issuer: issuer(),
      audience: INSTANCE,
      subject: sub,
      issuedAt,
      claims: { email, sid: `sid-${randomUUID()}`, ...claims },
    });
  return { user, sub, mint };
};

const logoutToken = (claims: { sub?: string; sid?: string }) => {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({
    ...(claims.sid && { sid: claims.sid }),
    // the event name the back-channel logout specification defines
    // eslint-disable-next-line unicorn/prefer-https
    events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'issuer-1', typ: 'logout+jwt' })
    .setIssuer(issuer())
    .setAudience(INSTANCE)
    .setIssuedAt(now)
    .setJti(randomUUID());
  if (claims.sub) {
    jwt.setSubject(claims.sub);
  }
  return jwt.sign(issuerKey);
};

const sessionsOf = async (ctx: MediumTestContext, userId: string) =>
  (await ctx.get(SessionRepository).getByUserId(userId)).map(({ id }) => id);

describe('Frameleaf token exchange sessions', () => {
  it('signs in once per token with a tagged session that a back-channel logout ends', async () => {
    const { sut, ctx } = setup(FrameleafAuthService);
    const { sut: auth } = setup(AuthService);
    await link(ctx);
    const { user, sub, mint } = await person(ctx);
    const sid = `sid-${randomUUID()}`;
    const token = await mint({ sid });

    const response = await sut.exchangeToken({ token }, loginDetails);
    expect(response).toMatchObject({ userId: user.id, accessToken: expect.any(String) });
    const [sessionId] = await sessionsOf(ctx, user.id);
    await expect(ctx.get(FrameleafAccountRepository).getSession(sessionId)).resolves.toMatchObject({ sid, sub });
    await expect(ctx.get(FrameleafAccountRepository).getLinkBySub(sub)).resolves.toMatchObject({ userId: user.id });

    await expect(sut.exchangeToken({ token }, loginDetails)).rejects.toMatchObject({
      response: expect.objectContaining({ code: FrameleafTokenExchangeErrorCode.Replayed }),
    });
    expect(await sessionsOf(ctx, user.id)).toEqual([sessionId]);

    // a token minted before the logout is not accepted after it
    const minted = await mint({ sid });
    await auth.backchannelLogout({ logout_token: await logoutToken({ sid }) });
    expect(await sessionsOf(ctx, user.id)).toEqual([]);
    await expect(ctx.get(FrameleafAccountRepository).getSession(sessionId)).resolves.toBeUndefined();
    await expect(sut.exchangeToken({ token: minted }, loginDetails)).rejects.toMatchObject({
      response: expect.objectContaining({ code: FrameleafTokenExchangeErrorCode.NoAccess }),
    });
  });

  it('ends the account’s exchanged sessions when Frameleaf Cloud removes its access, and no one else’s', async () => {
    const { sut, ctx } = setup(FrameleafAuthService);
    const { sut: auth } = setup(AuthService);
    await link(ctx);
    const removed = await person(ctx);
    const kept = await person(ctx);
    await sut.exchangeToken({ token: await removed.mint() }, loginDetails);
    await sut.exchangeToken({ token: await removed.mint() }, loginDetails);
    await sut.exchangeToken({ token: await kept.mint() }, loginDetails);
    const pending = await removed.mint();
    expect(await sessionsOf(ctx, removed.user.id)).toHaveLength(2);

    // unsharing the server sends a back-channel logout for the account
    await auth.backchannelLogout({ logout_token: await logoutToken({ sub: removed.sub }) });

    expect(await sessionsOf(ctx, removed.user.id)).toEqual([]);
    expect(await sessionsOf(ctx, kept.user.id)).toHaveLength(1);
    await expect(sut.exchangeToken({ token: pending }, loginDetails)).rejects.toMatchObject({
      status: 403,
      response: expect.objectContaining({ code: FrameleafTokenExchangeErrorCode.NoAccess }),
    });
  });

  it('ends the other exchanged sessions when the person unlinks their Frameleaf account', async () => {
    const { sut, ctx } = setup(FrameleafAuthService);
    await link(ctx);
    const { user, mint } = await person(ctx);
    await sut.exchangeToken({ token: await mint() }, loginDetails);
    await sut.exchangeToken({ token: await mint() }, loginDetails);
    const [current, other] = await sessionsOf(ctx, user.id);
    const userAdmin = await ctx.get(UserRepository).get(user.id, {});

    await sut.unlink({ user: userAdmin!, session: { id: current } } as never);

    expect(await sessionsOf(ctx, user.id)).toEqual([current]);
    await expect(ctx.get(FrameleafAccountRepository).getSession(current)).resolves.toBeUndefined();
    await expect(ctx.get(FrameleafAccountRepository).getSession(other)).resolves.toBeUndefined();
  });

  it('ends every exchanged session when the server is unlinked, then refuses as not linked', async () => {
    const { sut, ctx } = setup(FrameleafAuthService);
    const { sut: cloudService } = setup(FrameleafCloudService);
    await link(ctx);
    const { user, mint } = await person(ctx);
    await sut.exchangeToken({ token: await mint() }, loginDetails);
    expect(await sessionsOf(ctx, user.id)).toHaveLength(1);

    await (cloudService as unknown as { endFrameleafSignIns: () => Promise<void> }).endFrameleafSignIns();
    await ctx.get(SystemMetadataRepository).set(SystemMetadataKey.FrameleafCloudLink, {
      status: 'unlinked',
      cloudUrl: cloud.url,
    } as never);

    expect(await sessionsOf(ctx, user.id)).toEqual([]);
    await expect(sut.exchangeToken({ token: await mint() }, loginDetails)).rejects.toMatchObject({
      response: expect.objectContaining({ code: FrameleafTokenExchangeErrorCode.NotLinked }),
    });
  });
});
