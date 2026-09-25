import { type JWK, SignJWT, exportJWK, generateKeyPair, importJWK, jwtVerify } from 'jose';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FrameleafInstanceIdentity } from 'src/types.js';
import { AdminAuditAction, SystemMetadataKey } from 'src/enum.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { OAuthRepository } from 'src/repositories/oauth.repository.js';
import { UNVERIFIED_EMAIL_MESSAGE } from 'src/services/auth.service.js';
import { FrameleafAuthService } from 'src/services/frameleaf-auth.service.js';
import { clearConfigCache } from 'src/utils/config.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { FakeCloud, startFakeCloud } from 'test/fake-frameleaf-cloud.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const loginDetails = { isSecure: true, clientIp: '127.0.0.1', deviceOS: '', deviceType: '', appVersion: null };
const INSTANCE = 'instance-1';

/**
 * Sign in with Frameleaf (FL-158) against a fake Frameleaf identity service: OpenID discovery,
 * RS256 ID tokens with a JWKS, and a token endpoint that only answers when the server's
 * `private_key_jwt` assertion verifies against its identity key.
 */
describe(FrameleafAuthService.name, () => {
  let sut: FrameleafAuthService;
  let mocks: ServiceMocks;
  let cloud: FakeCloud;
  let identityDir: string;
  let metadata: Map<string, unknown>;
  let idClaims: Record<string, unknown>;
  let issuerKey: CryptoKey;
  let issuerJwk: JWK;
  let assertions: Record<string, unknown>[];

  const issuer = () => `${cloud.url}/id`;
  const linkRecord = () => ({
    status: 'linked',
    cloudUrl: cloud.url,
    instanceId: INSTANCE,
    oidc: {
      issuer: issuer(),
      clientId: INSTANCE,
      scope: 'openid email profile',
      roleClaim: 'frameleaf_role',
      storageLabelClaim: '',
    },
  });

  const serveIssuer = () => {
    cloud.on('GET /id/.well-known/openid-configuration', () => ({
      status: 200,
      body: {
        issuer: issuer(),
        authorization_endpoint: `${issuer()}/auth`,
        token_endpoint: `${issuer()}/token`,
        jwks_uri: `${issuer()}/jwks`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['private_key_jwt', 'client_secret_post'],
      },
    }));
    cloud.on('GET /id/jwks', () => ({
      status: 200,
      body: { keys: [{ ...issuerJwk, kid: 'issuer-1', alg: 'RS256' }] },
    }));
    cloud.on('POST /id/token', async (request) => {
      const form = request.form();
      const identity = metadata.get(SystemMetadataKey.FrameleafInstance) as FrameleafInstanceIdentity;
      try {
        const { payload } = await jwtVerify(
          form.get('client_assertion') ?? '',
          await importJWK({ ...identity.publicJwk }, 'EdDSA'),
          { audience: `${issuer()}/token`, issuer: INSTANCE, subject: INSTANCE },
        );
        assertions.push(payload);
      } catch {
        return { status: 401, body: { error: 'invalid_client' } };
      }
      const now = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({ sid: 'fl-sid', auth_time: now, ...idClaims })
        .setProtectedHeader({ alg: 'RS256', kid: 'issuer-1' })
        .setIssuer(issuer())
        .setAudience(INSTANCE)
        .setSubject('fl-sub')
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(issuerKey);
      return {
        status: 200,
        body: { access_token: 'access', token_type: 'Bearer', expires_in: 300, id_token: idToken },
      };
    });
  };

  const callbackDto = {
    url: 'https://photos.example.test/auth/login?code=abc&state=state-1',
    state: 'state-1',
    codeVerifier: 'v'.repeat(43),
  };

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256', { extractable: true });
    issuerKey = pair.privateKey;
    issuerJwk = await exportJWK(pair.publicKey);
  });

  beforeEach(async () => {
    cloud = await startFakeCloud();
    identityDir = await mkdtemp(join(tmpdir(), 'frameleaf-signin-'));
    metadata = new Map([[SystemMetadataKey.FrameleafCloudLink, linkRecord()]]);
    idClaims = { email: 'Remote@Example.test', email_verified: true, name: 'Remote Person', frameleaf_role: 'user' };
    assertions = [];
    clearConfigCache();
    ({ sut, mocks } = newTestService(FrameleafAuthService, {
      frameleafCloud: new FrameleafCloudRepository(LoggingRepository.create()),
      instanceIdentity: new InstanceIdentityRepository(),
      oauth: new OAuthRepository(LoggingRepository.create()),
    }));
    const baseEnv = mocks.config.getEnv();
    mocks.config.getEnv.mockReturnValue({
      ...baseEnv,
      frameleafCloud: { ...baseEnv.frameleafCloud, url: cloud.url, identityDir },
    } as never);
    mocks.systemMetadata.get.mockImplementation((key) => Promise.resolve((metadata.get(key) ?? null) as never));
    mocks.systemMetadata.set.mockImplementation((key, value) => {
      metadata.set(key, value);
      return Promise.resolve();
    });
    mocks.database.withLock.mockImplementation((_lock, callback) => callback() as never);
    mocks.session.create.mockImplementation((row) => Promise.resolve({ id: 'session-1', ...row } as never));
    mocks.frameleafAccount.upsertLink.mockImplementation((row) =>
      Promise.resolve({ ...row, linkedAt: new Date(), lastSignInAt: null }),
    );
    serveIssuer();
  });

  afterEach(async () => {
    await cloud.close();
    await rm(identityDir, { recursive: true, force: true });
  });

  describe('authorize', () => {
    it('builds a PKCE authorization URL for a registered callback, from the link and not oauth.*', async () => {
      const { url, codeVerifier } = await sut.authorize({ redirectUri: 'https://photos.example.test/auth/login' });
      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe(`${issuer()}/auth`);
      expect(parsed.searchParams.get('client_id')).toBe(INSTANCE);
      expect(parsed.searchParams.get('scope')).toBe('openid email profile');
      expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
      expect(codeVerifier).toBeTruthy();
    });

    it('refuses an address that is not registered for this server', async () => {
      await expect(sut.authorize({ redirectUri: 'https://evil.test/steal' })).rejects.toThrow('not registered');
    });

    it('is unavailable when the stored issuer is not on the configured cloud', async () => {
      metadata.set(SystemMetadataKey.FrameleafCloudLink, {
        ...linkRecord(),
        oidc: { ...linkRecord().oidc, issuer: 'https://id.elsewhere.test' },
      });
      await expect(sut.authorize({ redirectUri: 'https://photos.example.test/auth/login' })).rejects.toThrow(
        'not available',
      );
      expect(cloud.requests).toHaveLength(0);
    });

    it('is unavailable when the server is not linked', async () => {
      metadata.delete(SystemMetadataKey.FrameleafCloudLink);
      await expect(sut.authorize({ redirectUri: 'https://photos.example.test/auth/login' })).rejects.toThrow(
        'not available',
      );
      expect(cloud.requests).toHaveLength(0);
    });
  });

  describe('callback', () => {
    it('creates the account Frameleaf Cloud authorized, with private_key_jwt, and tags the session', async () => {
      const created = UserFactory.create({ email: 'remote@example.test', name: 'Remote Person' });
      mocks.frameleafAccount.getLinkBySub.mockResolvedValue(void 0);
      mocks.user.getByEmail.mockResolvedValue(void 0);
      mocks.user.getAdmin.mockResolvedValue(UserFactory.create({ isAdmin: true }));
      mocks.clusterGroup.create.mockResolvedValue({ id: 'group-1' } as never);
      mocks.user.create.mockResolvedValue(created as never);

      const response = await sut.callback(callbackDto, {}, loginDetails);

      expect(assertions).toHaveLength(1);
      expect(assertions[0]).toMatchObject({ iss: INSTANCE, sub: INSTANCE, jti: expect.any(String) });
      expect(mocks.user.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'remote@example.test', name: 'Remote Person', isAdmin: false }),
      );
      expect(mocks.frameleafAccount.upsertLink).toHaveBeenCalledWith(
        expect.objectContaining({ userId: created.id, sub: 'fl-sub', autoRegistered: true, role: 'user' }),
      );
      expect(mocks.frameleafAccount.tagSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session-1', userId: created.id, sid: 'fl-sid', sub: 'fl-sub' }),
      );
      expect(mocks.adminAudit.create).toHaveBeenCalledWith([
        expect.objectContaining({ action: AdminAuditAction.FrameleafAccountLinked }),
      ]);
      expect(response.userId).toBe(created.id);
      // the administrator's own provider settings are never read for this
      expect(mocks.systemMetadata.set).not.toHaveBeenCalledWith(SystemMetadataKey.SystemConfig, expect.anything());
    });

    it('makes an administrator of a person Frameleaf Cloud names as one', async () => {
      idClaims.frameleaf_role = 'admin';
      const created = UserFactory.create({ isAdmin: true });
      mocks.frameleafAccount.getLinkBySub.mockResolvedValue(void 0);
      mocks.user.getByEmail.mockResolvedValue(void 0);
      mocks.clusterGroup.create.mockResolvedValue({ id: 'group-1' } as never);
      mocks.user.create.mockResolvedValue(created as never);

      await sut.callback(callbackDto, {}, loginDetails);
      expect(mocks.user.create).toHaveBeenCalledWith(expect.objectContaining({ isAdmin: true }));
    });

    it('links an existing account by its verified email', async () => {
      const existing = UserFactory.create({ email: 'remote@example.test' });
      mocks.frameleafAccount.getLinkBySub.mockResolvedValue(void 0);
      mocks.user.getByEmail.mockResolvedValue(existing as never);
      mocks.frameleafAccount.getLinkByUser.mockResolvedValue(void 0);

      const response = await sut.callback(callbackDto, {}, loginDetails);

      expect(mocks.user.create).not.toHaveBeenCalled();
      expect(mocks.frameleafAccount.upsertLink).toHaveBeenCalledWith(
        expect.objectContaining({ userId: existing.id, autoRegistered: false }),
      );
      expect(response.userId).toBe(existing.id);
    });

    it('refuses an unverified email before linking or creating anything', async () => {
      idClaims.email_verified = false;
      await expect(sut.callback(callbackDto, {}, loginDetails)).rejects.toThrow(UNVERIFIED_EMAIL_MESSAGE);
      expect(mocks.frameleafAccount.upsertLink).not.toHaveBeenCalled();
      expect(mocks.user.create).not.toHaveBeenCalled();
      expect(mocks.session.create).not.toHaveBeenCalled();
    });

    it('refuses an account already linked to a different Frameleaf account', async () => {
      const existing = UserFactory.create({ email: 'remote@example.test' });
      mocks.frameleafAccount.getLinkBySub.mockResolvedValue(void 0);
      mocks.user.getByEmail.mockResolvedValue(existing as never);
      mocks.frameleafAccount.getLinkByUser.mockResolvedValue({ sub: 'someone-else' } as never);
      await expect(sut.callback(callbackDto, {}, loginDetails)).rejects.toThrow('already linked');
    });

    it('does not finish when the cloud refuses the client assertion', async () => {
      cloud.on('POST /id/token', () => ({ status: 401, body: { error: 'invalid_client' } }));
      await expect(sut.callback(callbackDto, {}, loginDetails)).rejects.toThrow('did not finish');
    });
  });

  describe('handoff', () => {
    it('hands a tagged session to another address once', async () => {
      const user = UserFactory.create();
      const auth = AuthFactory.from(user).session({ id: 'session-1' }).build();
      mocks.frameleafAccount.getSession.mockResolvedValue({ sessionId: 'session-1' } as never);
      mocks.crypto.randomBytesAsText.mockReturnValue('handoff-code');

      const { code } = await sut.createHandoff(auth);
      expect(code).toBe('handoff-code');
      expect(mocks.frameleafAccount.setHandoff).toHaveBeenCalledWith('session-1', expect.any(String), expect.any(Date));

      mocks.frameleafAccount.takeHandoff.mockResolvedValue({
        sessionId: 'session-1',
        userId: user.id,
        sid: 'fl-sid',
        sub: 'fl-sub',
        authTime: null,
        handoffExpiresAt: new Date(Date.now() + 30_000),
      } as never);
      mocks.session.get.mockResolvedValue({ id: 'session-1' } as never);
      mocks.user.get.mockResolvedValue(user as never);
      mocks.crypto.randomBytesAsText.mockReturnValue('new-token');

      await expect(sut.redeemHandoff({ code }, loginDetails)).resolves.toMatchObject({ userId: user.id });
      expect(mocks.frameleafAccount.tagSession).toHaveBeenCalledWith(
        expect.objectContaining({ sid: 'fl-sid', sub: 'fl-sub', userId: user.id }),
      );

      mocks.frameleafAccount.takeHandoff.mockResolvedValue(void 0);
      await expect(sut.redeemHandoff({ code }, loginDetails)).rejects.toThrow('not valid');
    });

    it('refuses an expired code and a session Frameleaf did not create', async () => {
      const auth = AuthFactory.from().session({ id: 'session-2' }).build();
      mocks.frameleafAccount.getSession.mockResolvedValue(void 0);
      await expect(sut.createHandoff(auth)).rejects.toThrow('Only a Sign in with Frameleaf session');

      mocks.frameleafAccount.takeHandoff.mockResolvedValue({ handoffExpiresAt: new Date(Date.now() - 1000) } as never);
      await expect(sut.redeemHandoff({ code: 'old' }, loginDetails)).rejects.toThrow('not valid');
    });
  });

  describe('link and unlink', () => {
    it('links the Frameleaf account to the signed-in account', async () => {
      const user = UserFactory.create();
      const auth = AuthFactory.from(user).build();
      mocks.frameleafAccount.getLinkBySub.mockResolvedValue(void 0);
      mocks.user.get.mockResolvedValue(user as never);

      await sut.link(auth, callbackDto, {});
      expect(mocks.frameleafAccount.upsertLink).toHaveBeenCalledWith(
        expect.objectContaining({ userId: user.id, sub: 'fl-sub', email: 'remote@example.test' }),
      );
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_frameleaf_cloud', user.id, { topic: 'account' });
    });

    it('unlinks and ends the other Frameleaf sessions, keeping this one', async () => {
      const user = UserFactory.create();
      const auth = AuthFactory.from(user).session({ id: 'session-1' }).build();
      mocks.frameleafAccount.deleteLink.mockResolvedValue({ sub: 'fl-sub', email: 'remote@example.test' } as never);
      mocks.frameleafAccount.findSessions.mockResolvedValue([
        { sessionId: 'session-1' },
        { sessionId: 'session-2' },
      ] as never);
      mocks.session.delete.mockResolvedValue();
      mocks.user.get.mockResolvedValue(user as never);

      await sut.unlink(auth);
      expect(mocks.session.delete).toHaveBeenCalledTimes(1);
      expect(mocks.session.delete).toHaveBeenCalledWith('session-2');
      expect(mocks.frameleafAccount.deleteSessions).toHaveBeenCalledWith(['session-2']);
      expect(mocks.adminAudit.create).toHaveBeenCalledWith([
        expect.objectContaining({ action: AdminAuditAction.FrameleafAccountUnlinked }),
      ]);
    });

    it('reports the link state', async () => {
      const auth = AuthFactory.create();
      mocks.frameleafAccount.getLinkByUser.mockResolvedValue(void 0);
      await expect(sut.getLink(auth)).resolves.toEqual({
        available: true,
        linked: false,
        email: null,
        linkedAt: null,
        lastSignInAt: null,
      });
    });
  });
});
