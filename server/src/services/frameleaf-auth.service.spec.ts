import { type JWK, SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, importJWK, jwtVerify } from 'jose';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrameleafCloudLink, FrameleafInstanceIdentity } from 'src/types.js';
import { FrameleafTokenExchangeErrorCode } from 'src/dtos/frameleaf-auth.dto.js';
import { AdminAuditAction, DatabaseLock, JobStatus, SystemMetadataKey } from 'src/enum.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { OAuthRepository } from 'src/repositories/oauth.repository.js';
import { UNVERIFIED_EMAIL_MESSAGE } from 'src/services/auth.service.js';
import { FrameleafAuthService } from 'src/services/frameleaf-auth.service.js';
import { FrameleafCloudService } from 'src/services/frameleaf-cloud.service.js';
import { clearConfigCache } from 'src/utils/config.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { FakeCloud, startFakeCloud } from 'test/fake-frameleaf-cloud.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';
import { type ExchangeTokenOptions, mintExchangeToken } from 'test/fixtures/frameleaf-token-exchange.js';
import { ServiceMocks, type ServiceOverrides, newTestService } from 'test/utils.js';

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
  let edKey: CryptoKey;
  let edJwk: JWK;
  let idTokenAlg: 'RS256' | 'EdDSA';
  let assertions: Record<string, unknown>[];

  const issuer = () => `${cloud.url}/id`;
  const linkRecord = () => ({
    status: 'linked',
    cloudUrl: cloud.url,
    instanceId: INSTANCE,
    linkedAt: '2026-10-03T12:00:00.000Z',
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
        id_token_signing_alg_values_supported: ['RS256', 'EdDSA'],
        token_endpoint_auth_methods_supported: ['private_key_jwt', 'client_secret_post'],
      },
    }));
    cloud.on('GET /id/jwks', () => ({
      status: 200,
      body: {
        keys: [
          { ...issuerJwk, kid: 'issuer-1', alg: 'RS256' },
          { ...edJwk, kid: 'issuer-ed', alg: 'EdDSA' },
        ],
      },
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
        .setProtectedHeader(
          idTokenAlg === 'EdDSA' ? { alg: 'EdDSA', kid: 'issuer-ed' } : { alg: 'RS256', kid: 'issuer-1' },
        )
        .setIssuer(issuer())
        .setAudience(INSTANCE)
        .setSubject(typeof idClaims.sub === 'string' ? idClaims.sub : 'fl-sub')
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(idTokenAlg === 'EdDSA' ? edKey : issuerKey);
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
    const ed = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    edKey = ed.privateKey;
    edJwk = await exportJWK(ed.publicKey);
  });

  beforeEach(async () => {
    cloud = await startFakeCloud();
    identityDir = await mkdtemp(join(tmpdir(), 'frameleaf-signin-'));
    metadata = new Map([[SystemMetadataKey.FrameleafCloudLink, linkRecord()]]);
    idClaims = { email: 'Remote@Example.test', email_verified: true, name: 'Remote Person', frameleaf_role: 'user' };
    assertions = [];
    idTokenAlg = 'RS256';
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
    // FL-218: a promotion notifies the other administrators
    mocks.user.getAdmins.mockResolvedValue([]);
    mocks.systemMetadata.set.mockImplementation((key, value) => {
      metadata.set(key, value);
      return Promise.resolve();
    });
    mocks.database.withLock.mockImplementation((_lock, callback) => callback() as never);
    mocks.session.create.mockImplementation((row) => Promise.resolve({ id: 'session-1', ...row } as never));
    // FL-292: a set-up server (one administrator exists) unless a test says otherwise
    mocks.user.getAdmin.mockResolvedValue(UserFactory.create({ isAdmin: true }));
    mocks.frameleafAccount.upsertLink.mockImplementation((row) =>
      Promise.resolve({ ...row, access: row.access ?? null, linkedAt: new Date(), lastSignInAt: null }),
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
    it('links and creates the published instance claims through the signed OIDC callback with its actual subject and sid', async () => {
      const claims = cloudContractFixture<{
        sub: string;
        email: string;
        name: string;
        sid: string;
        frameleaf_role: string;
        frameleaf_access: string;
      }>('identity/instance-claims.json');
      idClaims = { ...claims };
      idTokenAlg = 'EdDSA';
      const created = UserFactory.create({ email: claims.email, name: claims.name, isAdmin: true });
      mocks.frameleafAccount.getLinkBySub.mockResolvedValue(void 0);
      mocks.user.getByEmail.mockResolvedValue(void 0);
      mocks.clusterGroup.create.mockResolvedValue({ id: 'group-1' } as never);
      mocks.user.create.mockResolvedValue(created as never);

      const response = await sut.callback(callbackDto, {}, loginDetails);
      expect(assertions).toHaveLength(1); // serveIssuer verifies the real private_key_jwt signature.
      expect(mocks.frameleafAccount.getLinkBySub).toHaveBeenCalledWith(claims.sub);
      expect(mocks.user.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: claims.email, name: claims.name, isAdmin: true, quotaSizeInBytes: null }),
      );
      expect(mocks.frameleafAccount.upsertLink).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: created.id,
          sub: claims.sub,
          email: claims.email,
          emailVerified: true,
          role: claims.frameleaf_role,
          access: claims.frameleaf_access,
          autoRegistered: true,
        }),
      );
      expect(mocks.frameleafAccount.tagSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session-1', userId: created.id, sub: claims.sub, sid: claims.sid }),
      );
      expect(response.userId).toBe(created.id);
      // Picture is not enforced by this consumer; this is not full-envelope or provider qualification.
    });

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

    it('accepts an EdDSA-signed ID token as well (the cloud uses Ed25519 keys)', async () => {
      idTokenAlg = 'EdDSA';
      const existing = UserFactory.create({ email: 'remote@example.test' });
      mocks.frameleafAccount.getLinkBySub.mockResolvedValue(void 0);
      mocks.user.getByEmail.mockResolvedValue(existing as never);
      mocks.frameleafAccount.getLinkByUser.mockResolvedValue(void 0);
      await expect(sut.callback(callbackDto, {}, loginDetails)).resolves.toMatchObject({ userId: existing.id });
    });

    it('makes an administrator of a person Frameleaf Cloud names as one', async () => {
      idClaims.frameleaf_role = 'admin';
      const created = UserFactory.create({ isAdmin: true });
      mocks.user.getAdmin.mockResolvedValue(UserFactory.create({ isAdmin: true }));
      mocks.frameleafAccount.getLinkBySub.mockResolvedValue(void 0);
      mocks.user.getByEmail.mockResolvedValue(void 0);
      mocks.clusterGroup.create.mockResolvedValue({ id: 'group-1' } as never);
      mocks.user.create.mockResolvedValue(created as never);

      await sut.callback(callbackDto, {}, loginDetails);
      expect(mocks.user.create).toHaveBeenCalledWith(expect.objectContaining({ isAdmin: true }));
    });

    describe('a server set up from the Frameleaf app (FL-292)', () => {
      beforeEach(() => {
        idClaims.frameleaf_role = 'admin';
        mocks.user.getAdmin.mockResolvedValue(void 0);
        mocks.frameleafAccount.getLinkBySub.mockResolvedValue(void 0);
        mocks.user.getByEmail.mockResolvedValue(void 0);
        mocks.clusterGroup.create.mockResolvedValue({ id: 'group-1' } as never);
        mocks.user.create.mockResolvedValue(UserFactory.create({ isAdmin: true }) as never);
      });

      it('makes the owner who linked it its first administrator, without a password', async () => {
        metadata.set(SystemMetadataKey.FrameleafCloudLink, { ...linkRecord(), accountId: 'fl-sub' });
        await sut.callback(callbackDto, {}, loginDetails);
        expect(mocks.user.create).toHaveBeenCalledWith(
          expect.objectContaining({ isAdmin: true, email: 'remote@example.test' }),
        );
        expect(mocks.user.create.mock.calls[0][0]).not.toHaveProperty('password');
        expect(mocks.adminAudit.create).toHaveBeenCalledWith([
          expect.objectContaining({ action: AdminAuditAction.AccountCreated, detail: 'server-claimed:app-frameleaf' }),
        ]);
      });

      it('never promotes a linked account that does not own the server while nobody administers it', async () => {
        metadata.set(SystemMetadataKey.FrameleafCloudLink, { ...linkRecord(), accountId: 'the-owner' });
        const linked = UserFactory.create({ isAdmin: false });
        mocks.frameleafAccount.getLinkBySub.mockResolvedValue({ userId: linked.id, sub: 'fl-sub' } as never);
        mocks.user.get.mockResolvedValue(linked as never);
        await expect(sut.callback(callbackDto, {}, loginDetails)).rejects.toThrow('signs in first');
        expect(mocks.user.update).not.toHaveBeenCalled();
        expect(mocks.session.create).not.toHaveBeenCalled();
      });

      it('lets nobody else become the first administrator', async () => {
        metadata.set(SystemMetadataKey.FrameleafCloudLink, { ...linkRecord(), accountId: 'someone-else' });
        await expect(sut.callback(callbackDto, {}, loginDetails)).rejects.toThrow('signs in first');
        delete idClaims.frameleaf_role;
        metadata.set(SystemMetadataKey.FrameleafCloudLink, { ...linkRecord(), accountId: 'fl-sub' });
        await expect(sut.callback(callbackDto, {}, loginDetails)).rejects.toThrow('signs in first');
        expect(mocks.user.create).not.toHaveBeenCalled();
      });
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

    describe('frameleaf_role on every sign-in (FL-177, as-built decision #32)', () => {
      const signInLinked = async (user: ReturnType<typeof UserFactory.create>) => {
        mocks.frameleafAccount.getLinkBySub.mockResolvedValue({
          userId: user.id,
          sub: 'fl-sub',
          autoRegistered: false,
        } as never);
        mocks.user.get.mockResolvedValue(user as never);
        mocks.user.update.mockImplementation((id, change) => Promise.resolve({ ...user, ...change, id } as never));
        return sut.callback(callbackDto, {}, loginDetails);
      };

      it('takes administration away from a linked account the cloud demoted', async () => {
        const user = UserFactory.create({ isAdmin: true });
        mocks.user.getAdmins.mockResolvedValue([user, UserFactory.create({ isAdmin: true })] as never);
        idClaims.frameleaf_role = 'user';

        await signInLinked(user);
        expect(mocks.user.update).toHaveBeenCalledWith(user.id, { isAdmin: false });
        expect(mocks.adminAudit.create).toHaveBeenCalledWith([
          expect.objectContaining({ userId: user.id, actorId: null, action: AdminAuditAction.AdminRevoked }),
        ]);
      });

      it('makes a linked account an administrator when the cloud promotes it', async () => {
        const user = UserFactory.create({ isAdmin: false });
        idClaims.frameleaf_role = 'admin';

        await signInLinked(user);
        expect(mocks.user.update).toHaveBeenCalledWith(user.id, { isAdmin: true });
        expect(mocks.adminAudit.create).toHaveBeenCalledWith([
          expect.objectContaining({ userId: user.id, action: AdminAuditAction.AdminGranted }),
        ]);
      });

      it('never demotes the last administrator, so the server stays manageable', async () => {
        const user = UserFactory.create({ isAdmin: true });
        mocks.user.getAdmins.mockResolvedValue([user] as never);
        idClaims.frameleaf_role = 'user';

        await expect(signInLinked(user)).resolves.toMatchObject({ userId: user.id });
        expect(mocks.user.update).not.toHaveBeenCalled();
      });

      it('never leaves the server without an administrator when two are demoted at once (FL-177 review)', async () => {
        const first = UserFactory.create({ isAdmin: true });
        const second = UserFactory.create({ isAdmin: true });
        const users = new Map([
          [first.id, first],
          [second.id, second],
        ]);
        // a real advisory lock serialises its holders; the mock does the same
        let queue: Promise<unknown> = Promise.resolve();
        mocks.database.withLock.mockImplementation((_lock, callback) => {
          const run = queue.then(() => callback());
          queue = run.catch(() => {});
          return run as never;
        });
        mocks.user.getAdmins.mockImplementation(() =>
          Promise.resolve(
            users
              .values()
              .filter((user) => user.isAdmin)
              .toArray() as never,
          ),
        );
        mocks.user.update.mockImplementation(async (id, change) => {
          // yield between the count and the write, where an unlocked demotion would interleave
          await new Promise((resolve) => setTimeout(resolve, 5));
          const next = { ...users.get(id)!, ...change } as typeof first;
          users.set(id, next);
          return next as never;
        });
        const applyRole = (user: typeof first) =>
          (sut as unknown as { applyRole: (user: unknown, role: 'user') => Promise<unknown> }).applyRole(user, 'user');

        await Promise.all([applyRole(first), applyRole(second)]);
        expect(
          users
            .values()
            .filter((user) => user.isAdmin)
            .toArray(),
        ).toHaveLength(1);
        expect(mocks.database.withLock).toHaveBeenCalledWith(DatabaseLock.FrameleafRoleChange, expect.any(Function));
      });

      it('grants nothing from frameleaf_access, and changes nothing without frameleaf_role', async () => {
        const user = UserFactory.create({ isAdmin: false });
        delete idClaims.frameleaf_role;
        idClaims.frameleaf_access = 'owner';

        await signInLinked(user);
        expect(mocks.user.update).not.toHaveBeenCalled();
        expect(mocks.frameleafAccount.touchLink).toHaveBeenCalledWith(user.id, expect.objectContaining({ role: null }));
      });
    });

    it('does not finish when the cloud refuses the client assertion', async () => {
      cloud.on('POST /id/token', () => ({ status: 401, body: { error: 'invalid_client' } }));
      await expect(sut.callback(callbackDto, {}, loginDetails)).rejects.toThrow('did not finish');
    });
  });

  describe('token exchange (FL-230)', () => {
    const mint = (options: Partial<ExchangeTokenOptions> = {}) =>
      mintExchangeToken({
        key: issuerKey,
        kid: 'issuer-1',
        alg: 'RS256',
        issuer: issuer(),
        audience: INSTANCE,
        ...options,
      });
    const refusal = (code: FrameleafTokenExchangeErrorCode, status: number) =>
      expect.objectContaining({ status, response: expect.objectContaining({ code }) });

    beforeEach(() => {
      mocks.frameleafAccount.redeemExchangeToken.mockResolvedValue('ok');
    });

    it('signs in with a valid token, without a browser or a token request, and tags the session', async () => {
      const created = UserFactory.create({ email: 'remote@example.test', name: 'Remote Person' });
      mocks.frameleafAccount.getLinkBySub.mockResolvedValue(void 0);
      mocks.user.getByEmail.mockResolvedValue(void 0);
      mocks.user.getAdmin.mockResolvedValue(UserFactory.create({ isAdmin: true }));
      mocks.clusterGroup.create.mockResolvedValue({ id: 'group-1' } as never);
      mocks.user.create.mockResolvedValue(created as never);
      const token = await mint({ jti: 'jti-valid' });

      const response = await sut.exchangeToken({ token }, loginDetails);

      expect(response.userId).toBe(created.id);
      expect(cloud.requests.some(({ path }) => path === '/id/token')).toBe(false);
      expect(mocks.frameleafAccount.redeemExchangeToken).toHaveBeenCalledWith(
        expect.objectContaining({ jti: 'jti-valid', sub: 'fl-sub', sid: 'fl-app-sid' }),
      );
      // the same account rules as the browser flow: Frameleaf Cloud authorized this person
      expect(mocks.user.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'remote@example.test', name: 'Remote Person', isAdmin: false }),
      );
      // FL-235 (owner decision, 2026-10-01): a person invited as a viewer gets their own regular account
      expect(mocks.frameleafAccount.upsertLink).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: created.id,
          sub: 'fl-sub',
          autoRegistered: true,
          role: 'user',
          access: 'viewer',
        }),
      );
      expect(mocks.partner.create).not.toHaveBeenCalled();
      expect(mocks.frameleafAccount.tagSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session-1', userId: created.id, sid: 'fl-app-sid', sub: 'fl-sub' }),
      );
      expect(mocks.frameleafAccount.touchLink).toHaveBeenCalledWith(
        created.id,
        expect.objectContaining({ role: 'user' }),
      );
    });

    describe('a server set up from the Frameleaf app (FL-292)', () => {
      beforeEach(() => {
        mocks.user.getAdmin.mockResolvedValue(void 0);
        mocks.frameleafAccount.getLinkBySub.mockResolvedValue(void 0);
        mocks.user.getByEmail.mockResolvedValue(void 0);
        mocks.clusterGroup.create.mockResolvedValue({ id: 'group-1' } as never);
        mocks.user.create.mockResolvedValue(UserFactory.create({ isAdmin: true }) as never);
      });

      it('gives the owner who claims it by token exchange no invited-account quota (FL-230, FL-235)', async () => {
        metadata.set(SystemMetadataKey.SystemConfig, { frameleafCloud: { signIn: { invitedStorageQuota: 5 } } });
        clearConfigCache();
        metadata.set(SystemMetadataKey.FrameleafCloudLink, { ...linkRecord(), accountId: 'fl-sub' });
        const token = await mint({ claims: { frameleaf_role: 'admin', frameleaf_access: 'owner' } });
        await sut.exchangeToken({ token }, loginDetails);
        expect(mocks.user.create).toHaveBeenCalledWith(
          expect.objectContaining({ isAdmin: true, quotaSizeInBytes: null }),
        );
        expect(mocks.frameleafAccount.upsertLink).toHaveBeenCalledWith(
          expect.objectContaining({ sub: 'fl-sub', access: 'owner', autoRegistered: true }),
        );
        expect(mocks.adminAudit.create).toHaveBeenCalledWith([
          expect.objectContaining({ action: AdminAuditAction.AccountCreated, detail: 'server-claimed:app-frameleaf' }),
        ]);
      });

      it('refuses anyone else by token exchange with no_access', async () => {
        metadata.set(SystemMetadataKey.FrameleafCloudLink, { ...linkRecord(), accountId: 'someone-else' });
        const token = await mint({ claims: { frameleaf_role: 'admin', frameleaf_access: 'admin' } });
        await expect(sut.exchangeToken({ token }, loginDetails)).rejects.toMatchObject({
          response: expect.objectContaining({ code: 'frameleaf_exchange_no_access' }),
        });
        expect(mocks.user.create).not.toHaveBeenCalled();
      });
    });

    describe('storage quota for invited accounts (FL-235)', () => {
      const GiB = 1024 ** 3;
      const setQuota = (invitedStorageQuota: number | null) => {
        metadata.set(SystemMetadataKey.SystemConfig, { frameleafCloud: { signIn: { invitedStorageQuota } } });
        clearConfigCache();
      };
      const newAccount = () => {
        const created = UserFactory.create({ email: 'remote@example.test' });
        mocks.frameleafAccount.getLinkBySub.mockResolvedValue(void 0);
        mocks.user.getByEmail.mockResolvedValue(void 0);
        mocks.user.getAdmin.mockResolvedValue(UserFactory.create({ isAdmin: true }));
        mocks.clusterGroup.create.mockResolvedValue({ id: 'group-1' } as never);
        mocks.user.create.mockResolvedValue(created as never);
        return created;
      };

      it('is unlimited by default, so backup works out of the box', async () => {
        newAccount();
        await sut.exchangeToken({ token: await mint() }, loginDetails);
        expect(mocks.user.create).toHaveBeenCalledWith(expect.objectContaining({ quotaSizeInBytes: null }));
      });

      it('gives a new invited account the quota the administrator set', async () => {
        setQuota(5);
        newAccount();
        await sut.exchangeToken({ token: await mint() }, loginDetails);
        expect(mocks.user.create).toHaveBeenCalledWith(expect.objectContaining({ quotaSizeInBytes: 5 * GiB }));
      });

      it('never caps the server owner', async () => {
        setQuota(5);
        newAccount();
        const token = await mint({ claims: { frameleaf_role: 'admin', frameleaf_access: 'owner' } });
        await sut.exchangeToken({ token }, loginDetails);
        expect(mocks.user.create).toHaveBeenCalledWith(expect.objectContaining({ quotaSizeInBytes: null }));
      });

      it('recognises the owner by the cloud link’s account when the server knows it', async () => {
        setQuota(5);
        metadata.set(SystemMetadataKey.FrameleafCloudLink, { ...linkRecord(), accountId: 'fl-sub' });
        newAccount();
        await sut.exchangeToken({ token: await mint() }, loginDetails);
        expect(mocks.user.create).toHaveBeenLastCalledWith(expect.objectContaining({ quotaSizeInBytes: null }));

        metadata.set(SystemMetadataKey.FrameleafCloudLink, { ...linkRecord(), accountId: 'someone-else' });
        const token = await mint({ claims: { frameleaf_role: 'admin', frameleaf_access: 'owner' } });
        await sut.exchangeToken({ token }, loginDetails);
        expect(mocks.user.create).toHaveBeenLastCalledWith(expect.objectContaining({ quotaSizeInBytes: 5 * GiB }));
      });

      it('leaves existing accounts unchanged', async () => {
        setQuota(5);
        const existing = UserFactory.create({ email: 'remote@example.test' });
        mocks.frameleafAccount.getLinkBySub.mockResolvedValue(void 0);
        mocks.user.getByEmail.mockResolvedValue(existing as never);
        mocks.frameleafAccount.getLinkByUser.mockResolvedValue(void 0);
        await sut.exchangeToken({ token: await mint() }, loginDetails);
        expect(mocks.user.create).not.toHaveBeenCalled();
        expect(mocks.user.update).not.toHaveBeenCalledWith(
          existing.id,
          expect.objectContaining({ quotaSizeInBytes: expect.anything() }),
        );
      });
    });

    it('accepts an EdDSA-signed token and links an existing account by its verified email', async () => {
      const existing = UserFactory.create({ email: 'remote@example.test' });
      mocks.frameleafAccount.getLinkBySub.mockResolvedValue(void 0);
      mocks.user.getByEmail.mockResolvedValue(existing as never);
      mocks.frameleafAccount.getLinkByUser.mockResolvedValue(void 0);
      const token = await mint({ key: edKey, kid: 'issuer-ed', alg: 'EdDSA' });

      await expect(sut.exchangeToken({ token }, loginDetails)).resolves.toMatchObject({ userId: existing.id });
      expect(mocks.user.create).not.toHaveBeenCalled();
      expect(mocks.frameleafAccount.upsertLink).toHaveBeenCalledWith(
        expect.objectContaining({ userId: existing.id, autoRegistered: false }),
      );
    });

    it('signs in to the account the Frameleaf account is already linked to and applies frameleaf_role', async () => {
      const user = UserFactory.create({ isAdmin: false });
      mocks.frameleafAccount.getLinkBySub.mockResolvedValue({ userId: user.id, sub: 'fl-sub' } as never);
      mocks.user.get.mockResolvedValue(user as never);
      mocks.user.update.mockImplementation((id, change) => Promise.resolve({ ...user, ...change, id } as never));
      const token = await mint({ claims: { frameleaf_role: 'admin', frameleaf_access: 'admin' } });

      await expect(sut.exchangeToken({ token }, loginDetails)).resolves.toMatchObject({ userId: user.id });
      expect(mocks.user.update).toHaveBeenCalledWith(user.id, { isAdmin: true });
      // FL-235: the latest access is recorded on every sign-in
      expect(mocks.frameleafAccount.touchLink).toHaveBeenCalledWith(
        user.id,
        expect.objectContaining({ role: 'admin', access: 'admin' }),
      );
    });

    it('refuses a token for another server (wrong audience)', async () => {
      const token = await mint({ audience: 'another-instance' });
      await expect(sut.exchangeToken({ token }, loginDetails)).rejects.toEqual(
        refusal(FrameleafTokenExchangeErrorCode.WrongAudience, 401),
      );
      expect(mocks.frameleafAccount.redeemExchangeToken).not.toHaveBeenCalled();
      expect(mocks.session.create).not.toHaveBeenCalled();
    });

    it('refuses an expired token, and one minted more than two minutes ago', async () => {
      const now = Math.floor(Date.now() / 1000);
      for (const token of [
        await mint({ issuedAt: now - 200, lifetimeSeconds: 60 }),
        await mint({ issuedAt: now - 3 * 60, lifetimeSeconds: 3600 }),
      ]) {
        await expect(sut.exchangeToken({ token }, loginDetails)).rejects.toEqual(
          refusal(FrameleafTokenExchangeErrorCode.Expired, 401),
        );
      }
      expect(mocks.frameleafAccount.redeemExchangeToken).not.toHaveBeenCalled();
      expect(mocks.session.create).not.toHaveBeenCalled();
    });

    it('refuses a replayed token: each one signs in once', async () => {
      const used = new Set<string>();
      mocks.frameleafAccount.redeemExchangeToken.mockImplementation(({ jti }) => {
        if (used.has(jti)) {
          return Promise.resolve('replayed');
        }
        used.add(jti);
        return Promise.resolve('ok');
      });
      const user = UserFactory.create();
      mocks.frameleafAccount.getLinkBySub.mockResolvedValue({ userId: user.id, sub: 'fl-sub' } as never);
      mocks.user.get.mockResolvedValue(user as never);
      const token = await mint();

      await expect(sut.exchangeToken({ token }, loginDetails)).resolves.toMatchObject({ userId: user.id });
      await expect(sut.exchangeToken({ token }, loginDetails)).rejects.toEqual(
        refusal(FrameleafTokenExchangeErrorCode.Replayed, 401),
      );
      expect(mocks.session.create).toHaveBeenCalledTimes(1);
      // the replay store keeps a token only as long as it could be accepted
      const [{ expiresAt }] = mocks.frameleafAccount.redeemExchangeToken.mock.calls[0];
      expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 3 * 60 * 1000);
    });

    it('refuses when the server is not linked, without reaching Frameleaf Cloud', async () => {
      const token = await mint();
      metadata.delete(SystemMetadataKey.FrameleafCloudLink);
      await expect(sut.exchangeToken({ token }, loginDetails)).rejects.toEqual(
        refusal(FrameleafTokenExchangeErrorCode.NotLinked, 400),
      );
      metadata.set(SystemMetadataKey.FrameleafCloudLink, { ...linkRecord(), status: 'revoked' });
      await expect(sut.exchangeToken({ token }, loginDetails)).rejects.toEqual(
        refusal(FrameleafTokenExchangeErrorCode.NotLinked, 400),
      );
      expect(cloud.requests).toHaveLength(0);
    });

    it('refuses when Sign in with Frameleaf is off for this linked server', async () => {
      const token = await mint();
      for (const oidc of [undefined, { ...linkRecord().oidc, issuer: 'https://id.elsewhere.test' }]) {
        metadata.set(SystemMetadataKey.FrameleafCloudLink, { ...linkRecord(), oidc });
        await expect(sut.exchangeToken({ token }, loginDetails)).rejects.toEqual(
          refusal(FrameleafTokenExchangeErrorCode.SignInOff, 400),
        );
      }
      expect(cloud.requests).toHaveLength(0);
    });

    it('refuses a token without the instance-access claims (no access)', async () => {
      for (const claims of [
        { frameleaf_access: undefined },
        { frameleaf_access: 'none' },
        { frameleaf_role: undefined },
        { frameleaf_role: 'owner' },
      ]) {
        const token = await mint({ claims });
        await expect(sut.exchangeToken({ token }, loginDetails)).rejects.toEqual(
          refusal(FrameleafTokenExchangeErrorCode.NoAccess, 403),
        );
      }
      expect(mocks.frameleafAccount.redeemExchangeToken).not.toHaveBeenCalled();
      expect(mocks.session.create).not.toHaveBeenCalled();
    });

    it('refuses a token minted before Frameleaf Cloud removed the access (revoked access)', async () => {
      mocks.frameleafAccount.redeemExchangeToken.mockResolvedValue('revoked');
      const token = await mint();
      await expect(sut.exchangeToken({ token }, loginDetails)).rejects.toEqual(
        refusal(FrameleafTokenExchangeErrorCode.NoAccess, 403),
      );
      expect(mocks.frameleafAccount.redeemExchangeToken).toHaveBeenCalledWith(
        expect.objectContaining({ sub: 'fl-sub', sid: 'fl-app-sid', issuedAt: expect.any(Date) }),
      );
      expect(mocks.session.create).not.toHaveBeenCalled();
    });

    it('ends the session when Frameleaf Cloud ended the sign-ins while it was being created', async () => {
      const user = UserFactory.create();
      mocks.frameleafAccount.getLinkBySub.mockResolvedValue({ userId: user.id, sub: 'fl-sub' } as never);
      mocks.user.get.mockResolvedValue(user as never);
      mocks.frameleafAccount.isSignInRevoked.mockResolvedValue(true);
      mocks.session.delete.mockResolvedValue();

      await expect(sut.exchangeToken({ token: await mint() }, loginDetails)).rejects.toEqual(
        refusal(FrameleafTokenExchangeErrorCode.NoAccess, 403),
      );
      expect(mocks.frameleafAccount.isSignInRevoked).toHaveBeenCalledWith(
        expect.objectContaining({ sub: 'fl-sub', sid: 'fl-app-sid', issuedAt: expect.any(Date) }),
      );
      expect(mocks.frameleafAccount.tagSession.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.frameleafAccount.isSignInRevoked.mock.invocationCallOrder[0],
      );
      expect(mocks.session.delete).toHaveBeenCalledWith('session-1');
      expect(mocks.event.emit).toHaveBeenCalledWith('SessionDelete', { sessionId: 'session-1' });
      expect(mocks.frameleafAccount.deleteSessions).toHaveBeenCalledWith(['session-1']);
    });

    it('refuses an ordinary ID token, a token without jti, another issuer and another key', async () => {
      const other = await generateKeyPair('RS256');
      for (const token of [
        await mint({ typ: null }),
        await mint({ typ: 'JWT' }),
        await mint({ jti: null }),
        await mint({ issuer: 'https://id.elsewhere.test' }),
        await mint({ key: other.privateKey }),
        'not-a-token',
      ]) {
        await expect(sut.exchangeToken({ token }, loginDetails)).rejects.toEqual(
          refusal(FrameleafTokenExchangeErrorCode.Invalid, 401),
        );
      }
      expect(mocks.frameleafAccount.redeemExchangeToken).not.toHaveBeenCalled();
      expect(mocks.session.create).not.toHaveBeenCalled();
    });

    it('applies the browser flow’s account refusals, each with its own code', async () => {
      await expect(
        sut.exchangeToken({ token: await mint({ claims: { email_verified: false } }) }, loginDetails),
      ).rejects.toEqual(refusal(FrameleafTokenExchangeErrorCode.EmailUnverified, 400));

      mocks.frameleafAccount.getLinkBySub.mockResolvedValue({ userId: 'deleted-user', sub: 'fl-sub' } as never);
      mocks.user.get.mockResolvedValue(void 0);
      await expect(sut.exchangeToken({ token: await mint() }, loginDetails)).rejects.toEqual(
        refusal(FrameleafTokenExchangeErrorCode.AccountRemoved, 400),
      );

      mocks.frameleafAccount.getLinkBySub.mockResolvedValue(void 0);
      mocks.user.getByEmail.mockResolvedValue(UserFactory.create({ email: 'remote@example.test' }) as never);
      mocks.frameleafAccount.getLinkByUser.mockResolvedValue({ sub: 'someone-else' } as never);
      await expect(sut.exchangeToken({ token: await mint() }, loginDetails)).rejects.toEqual(
        refusal(FrameleafTokenExchangeErrorCode.AccountConflict, 400),
      );
      expect(mocks.user.create).not.toHaveBeenCalled();
      expect(mocks.session.create).not.toHaveBeenCalled();
    });
  });

  /**
   * FL-230 against Frameleaf Cloud's own FC-86 contract fixtures
   * (`packages/contracts/fixtures/identity/exchange/`, see `frameleaf-cloud-contracts/SOURCE.md`): the
   * tokens the cloud's token-exchange grant mints, verified at the instant each fixture names, with the
   * fixture issuer's JWKS standing in for the linked issuer's.
   */
  describe('token exchange against the cloud contract fixtures (FC-86)', () => {
    type ExchangeFixture = { token: string; now: number; issuer: string; audience: string; expect: string };
    const fixture = (name: string) => cloudContractFixture<ExchangeFixture>(`identity/exchange/${name}.json`);
    const jwks = cloudContractFixture('identity/exchange/jwks.json');
    const codes: Record<string, FrameleafTokenExchangeErrorCode> = {
      wrong_audience: FrameleafTokenExchangeErrorCode.WrongAudience,
      expired: FrameleafTokenExchangeErrorCode.Expired,
      replayed: FrameleafTokenExchangeErrorCode.Replayed,
      invalid: FrameleafTokenExchangeErrorCode.Invalid,
    };

    const verifyAs = (at: ExchangeFixture) => {
      vi.setSystemTime(at.now * 1000);
      metadata.set(SystemMetadataKey.FrameleafCloudLink, {
        ...linkRecord(),
        oidc: { ...linkRecord().oidc, clientId: at.audience },
      });
    };

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.spyOn(
        OAuthRepository.prototype as unknown as { getVerification: () => Promise<unknown> },
        'getVerification',
      ).mockResolvedValue({
        issuer: fixture('valid').issuer,
        key: createLocalJWKSet(jwks),
        algorithms: ['RS256'],
      } as never);
      const used = new Set<string>();
      mocks.frameleafAccount.redeemExchangeToken.mockImplementation(({ jti }) => {
        const outcome = used.has(jti) ? 'replayed' : 'ok';
        used.add(jti);
        return Promise.resolve(outcome);
      });
      mocks.frameleafAccount.getLinkBySub.mockResolvedValue(void 0);
      mocks.user.getByEmail.mockResolvedValue(void 0);
      mocks.user.getAdmin.mockResolvedValue(UserFactory.create({ isAdmin: true }));
      mocks.clusterGroup.create.mockResolvedValue({ id: 'group-1' } as never);
      mocks.user.create.mockResolvedValue(UserFactory.create({ email: 'owner@example.com', isAdmin: true }) as never);
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('signs in with the valid token, once', async () => {
      const valid = fixture('valid');
      expect(valid.expect).toBe('ok');
      verifyAs(valid);
      await expect(sut.exchangeToken({ token: valid.token }, loginDetails)).resolves.toMatchObject({
        userEmail: 'owner@example.com',
      });
      expect(mocks.frameleafAccount.tagSession).toHaveBeenCalledWith(
        expect.objectContaining({ sub: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', sid: expect.any(String) }),
      );

      const replayed = fixture('replayed');
      verifyAs(replayed);
      await expect(sut.exchangeToken({ token: replayed.token }, loginDetails)).rejects.toEqual(
        expect.objectContaining({ response: expect.objectContaining({ code: codes[replayed.expect] }) }),
      );
    });

    it.each(['wrong-audience', 'expired', 'plain-id-token'])(
      'refuses %s with the code the cloud expects',
      async (name) => {
        const at = fixture(name);
        verifyAs(at);
        await expect(sut.exchangeToken({ token: at.token }, loginDetails)).rejects.toEqual(
          expect.objectContaining({ response: expect.objectContaining({ code: codes[at.expect] }) }),
        );
        expect(mocks.session.create).not.toHaveBeenCalled();
      },
    );

    it('accepts the logout token that ends the exchanged session', async () => {
      const logout = cloudContractFixture<ExchangeFixture & { ends: { sub: string; sid: string } }>(
        'identity/exchange/logout-token.json',
      );
      vi.setSystemTime(logout.now * 1000);
      const oauth = new OAuthRepository(LoggingRepository.create());
      await expect(oauth.validateLogoutToken({ clientId: logout.audience } as never, logout.token)).resolves.toEqual(
        logout.ends,
      );
    });
  });

  describe('back-channel logout tokens', () => {
    it('verifies an EdDSA-signed logout token against the Frameleaf JWKS', async () => {
      const config = await (sut as unknown as { config: () => Promise<never> }).config();
      const now = Math.floor(Date.now() / 1000);
      const token = await new SignJWT({
        sid: 'fl-sid',
        // the event name the back-channel logout specification defines
        // eslint-disable-next-line unicorn/prefer-https
        events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
      })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'issuer-ed', typ: 'logout+jwt' })
        .setIssuer(issuer())
        .setAudience(INSTANCE)
        .setSubject('fl-sub')
        .setIssuedAt(now)
        .setJti('logout-1')
        .sign(edKey);
      const repository = (sut as unknown as { oauthRepository: OAuthRepository }).oauthRepository;
      await expect(repository.validateLogoutToken(config, token)).resolves.toEqual({ sid: 'fl-sid', sub: 'fl-sub' });
    });
  });

  describe('handoff', () => {
    it('hands a tagged session to another address once', async () => {
      const user = UserFactory.create();
      const auth = AuthFactory.from(user).session({ id: 'session-1' }).build();
      mocks.frameleafAccount.getSession.mockResolvedValue({ sessionId: 'session-1', sub: 'fl-sub' } as never);
      mocks.frameleafAccount.getLinkByUser.mockResolvedValue({ sub: 'fl-sub' } as never);
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

    it('returns only to a home address this server published (FL-167)', async () => {
      const LAN = 'https://192-168-1-10.u225vlzhsdlhwh4l.frameleaf.net:2443';
      const auth = AuthFactory.from(UserFactory.create()).session({ id: 'session-3' }).build();
      mocks.frameleafAccount.getSession.mockResolvedValue({ sessionId: 'session-3', sub: 'fl-sub' } as never);
      mocks.frameleafAccount.getLinkByUser.mockResolvedValue({ sub: 'fl-sub' } as never);
      mocks.crypto.randomBytesAsText.mockReturnValue('handoff-code');
      metadata.set(SystemMetadataKey.SystemConfig, { frameleafCloud: { remoteAccess: { enabled: true } } });
      metadata.set(SystemMetadataKey.FrameleafRemoteAccess, {
        status: 'ready',
        updatedAt: new Date().toISOString(),
        names: {
          instanceId: INSTANCE,
          label: 'u225vlzhsdlhwh4l',
          domain: 'frameleaf.net',
          names: { relay: 'r.u225vlzhsdlhwh4l.frameleaf.net' },
        },
        relay: { connected: true },
        direct: { listening: true, port: 2443, cgnatSuspected: false },
        candidates: [
          { kind: 'local', uri: LAN, local: true, relay: false },
          { kind: 'relay', uri: 'https://r.u225vlzhsdlhwh4l.frameleaf.net', local: false, relay: true },
        ],
      });

      await expect(sut.createHandoff(auth, { returnTo: `${LAN}/photos` })).resolves.toMatchObject({
        code: 'handoff-code',
        url: `${LAN}/auth/login#frameleafHandoff=handoff-code`,
      });
      for (const returnTo of [
        'https://evil.example.com',
        'https://r.u225vlzhsdlhwh4l.frameleaf.net',
        LAN.replace('https:', 'http:'),
        'https://user@192-168-1-10.u225vlzhsdlhwh4l.frameleaf.net:2443',
        'javascript:alert(1)',
        'not a url',
      ]) {
        await expect(sut.createHandoff(auth, { returnTo })).rejects.toThrow('home addresses');
      }
      // no code is made for a refused address
      expect(mocks.frameleafAccount.setHandoff).toHaveBeenCalledTimes(1);

      // an edge worker that stopped reporting published nothing
      metadata.set(SystemMetadataKey.FrameleafRemoteAccess, {
        ...(metadata.get(SystemMetadataKey.FrameleafRemoteAccess) as object),
        updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      });
      await expect(sut.createHandoff(auth, { returnTo: LAN })).rejects.toThrow('home addresses');
    });

    it('refuses an expired code and a session Frameleaf did not create', async () => {
      const auth = AuthFactory.from().session({ id: 'session-2' }).build();
      mocks.frameleafAccount.getSession.mockResolvedValue(void 0);
      await expect(sut.createHandoff(auth)).rejects.toThrow('Only a Sign in with Frameleaf session');

      mocks.frameleafAccount.takeHandoff.mockResolvedValue({ handoffExpiresAt: new Date(Date.now() - 1000) } as never);
      await expect(sut.redeemHandoff({ code: 'old' }, loginDetails)).rejects.toThrow('not valid');
    });
  });

  describe('accounts being removed and unlinked sessions', () => {
    it('refuses a sign-in whose linked account is in the trash, without creating another', async () => {
      mocks.frameleafAccount.getLinkBySub.mockResolvedValue({ userId: 'deleted-user', sub: 'fl-sub' } as never);
      mocks.user.get.mockResolvedValue(void 0);
      await expect(sut.callback(callbackDto, {}, loginDetails)).rejects.toThrow('being removed from this server');
      expect(mocks.user.create).not.toHaveBeenCalled();
      expect(mocks.frameleafAccount.upsertLink).not.toHaveBeenCalled();
    });

    it('refuses to link a Frameleaf account held by an account in the trash', async () => {
      const auth = AuthFactory.create();
      mocks.frameleafAccount.getLinkBySub.mockResolvedValue({ userId: 'deleted-user', sub: 'fl-sub' } as never);
      mocks.user.get.mockResolvedValue(void 0);
      await expect(sut.link(auth, callbackDto, {})).rejects.toThrow('being removed from this server');
      expect(mocks.frameleafAccount.upsertLink).not.toHaveBeenCalled();
    });

    it('does not hand over a session whose account is no longer linked', async () => {
      const auth = AuthFactory.from().session({ id: 'session-1' }).build();
      mocks.frameleafAccount.getSession.mockResolvedValue({ sessionId: 'session-1', sub: 'fl-sub' } as never);
      mocks.frameleafAccount.getLinkByUser.mockResolvedValue(void 0);
      await expect(sut.createHandoff(auth)).rejects.toThrow('Only a Sign in with Frameleaf session');
      expect(mocks.frameleafAccount.setHandoff).not.toHaveBeenCalled();
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

    describe('a cloud admin share on link (FL-218, owner decision 2026-10-03)', () => {
      const setup = (isAdmin: boolean) => {
        const user = UserFactory.create({ isAdmin });
        const admin = UserFactory.create({ isAdmin: true });
        const auth = AuthFactory.from(user).session({ id: 'session-1' }).build();
        mocks.frameleafAccount.getLinkBySub.mockResolvedValue(void 0);
        mocks.user.get.mockResolvedValue(user as never);
        mocks.user.update.mockImplementation((id, change) => Promise.resolve({ ...user, ...change, id } as never));
        mocks.user.getAdmins.mockResolvedValue([admin] as never);
        mocks.notification.create.mockImplementation((value) =>
          Promise.resolve({ id: 'notification-1', createdAt: new Date(), readAt: null, data: null, ...value } as never),
        );
        return { user, admin, auth };
      };

      const shareAuthorityFence = () => {
        const held = new AsyncLocalStorage<DatabaseLock[]>();
        const tails = new Map<DatabaseLock, Promise<void>>();
        // Like the production local/advisory lock: serialize each key and refuse reentrant acquisition.
        mocks.database.withLock.mockImplementation((lock, callback) => {
          const locks = held.getStore() ?? [];
          if (locks.includes(lock)) {
            return Promise.reject(new Error('Reentrant authority lock would deadlock'));
          }
          const prior = tails.get(lock) ?? Promise.resolve();
          const { promise: finished, resolve: release } = Promise.withResolvers<void>();
          tails.set(
            lock,
            prior.then(() => finished),
          );
          return prior.then(() => held.run([...locks, lock], callback)).finally(() => release()) as never;
        });
        const { sut: cloudService } = newTestService(FrameleafCloudService, mocks as unknown as ServiceOverrides);
        mocks.systemMetadata.set.mockImplementation((key, value) => {
          if (key === SystemMetadataKey.FrameleafCloudLink) {
            expect(held.getStore()).toContain(DatabaseLock.FrameleafLinkAuthority);
          }
          metadata.set(key, value);
          return Promise.resolve();
        });
        mocks.frameleafAccount.deleteAllLinks.mockImplementation(() => {
          expect(held.getStore()).toContain(DatabaseLock.FrameleafLinkAuthority);
          return Promise.resolve([]);
        });
        // Configuration cleanup follows the authority mutation; keep this regression about the real link cleanup.
        vi.spyOn(cloudService, 'updateConfigExclusively').mockResolvedValue({
          oldConfig: { frameleafCloud: {} },
          newConfig: { frameleafCloud: {} },
        } as never);
        mocks.frameleafAccount.deleteAllSessions.mockResolvedValue([]);
        const cloudAuthority = cloudService as unknown as {
          clearLink: (url: string, link: FrameleafCloudLink, status: 'unlinked' | 'revoked') => Promise<void>;
          saveLink: (
            link: FrameleafCloudLink,
            topic: null,
            options?: { replaceAuthority: boolean },
          ) => Promise<boolean>;
          checkIn: (url: string, link: FrameleafCloudLink) => Promise<JobStatus>;
        };
        return { held, cloudAuthority, cloudService };
      };

      it('makes the linked account an administrator at once and notifies the other administrators', async () => {
        const { user, admin, auth } = setup(false);
        idClaims.frameleaf_role = 'admin';

        const result = await sut.link(auth, callbackDto, {});
        expect(result).toMatchObject({ linked: true, roleChange: 'granted-admin', isAdmin: true, confirmToken: null });
        expect(mocks.user.update).toHaveBeenCalledWith(user.id, { isAdmin: true });
        expect(mocks.adminAudit.create).toHaveBeenCalledWith([
          expect.objectContaining({ userId: user.id, actorId: null, action: AdminAuditAction.AdminGranted }),
        ]);
        expect(mocks.notification.create).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: admin.id,
            description: `${user.name} became an administrator through Frameleaf Cloud`,
          }),
        );
        expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_notification', admin.id, expect.anything());
      });

      it('changes no role for a share that is not admin', async () => {
        const { auth } = setup(false);
        idClaims.frameleaf_role = 'user';

        const result = await sut.link(auth, callbackDto, {});
        expect(result).toMatchObject({ linked: true, roleChange: 'none', isAdmin: false });
        expect(mocks.user.update).not.toHaveBeenCalled();
        expect(mocks.notification.create).not.toHaveBeenCalled();
      });

      it('never demotes at link time; demotion waits for sign-in', async () => {
        const { auth } = setup(true);
        idClaims.frameleaf_role = 'user';

        await expect(sut.link(auth, callbackDto, {})).resolves.toMatchObject({ roleChange: 'none', isAdmin: true });
        expect(mocks.user.update).not.toHaveBeenCalled();
      });

      it('previews the promotion without linking, then links on confirm', async () => {
        const { user, auth } = setup(false);
        idClaims.frameleaf_role = 'admin';

        const preview = await sut.link(auth, { ...callbackDto, preview: true }, {});
        expect(preview).toMatchObject({ linked: false, roleChange: 'granted-admin', isAdmin: false });
        expect(preview.confirmToken).toEqual(expect.any(String));
        expect(mocks.frameleafAccount.upsertLink).not.toHaveBeenCalled();
        expect(mocks.user.update).not.toHaveBeenCalled();

        const confirmed = await sut.confirmLink(auth, { confirmToken: preview.confirmToken! });
        expect(confirmed).toMatchObject({ linked: true, roleChange: 'granted-admin', isAdmin: true });
        expect(mocks.frameleafAccount.upsertLink).toHaveBeenCalledWith(
          expect.objectContaining({ userId: user.id, sub: 'fl-sub', role: 'admin' }),
        );
      });

      it.each(['unlinked', 'revoked', 'removed'])('refuses confirmation after the Cloud link is %s', async (status) => {
        const { auth } = setup(false);
        idClaims.frameleaf_role = 'admin';
        const { confirmToken } = await sut.link(auth, { ...callbackDto, preview: true }, {});

        if (status === 'removed') {
          metadata.delete(SystemMetadataKey.FrameleafCloudLink);
        } else {
          metadata.set(SystemMetadataKey.FrameleafCloudLink, { ...linkRecord(), status });
        }

        await expect(sut.confirmLink(auth, { confirmToken: confirmToken! })).rejects.toThrow('not available');
        expect(mocks.frameleafAccount.upsertLink).not.toHaveBeenCalled();
        expect(mocks.user.update).not.toHaveBeenCalled();
        expect(mocks.adminAudit.create).not.toHaveBeenCalled();
        expect(mocks.notification.create).not.toHaveBeenCalled();
        expect(mocks.websocket.clientSend).not.toHaveBeenCalled();
      });

      it.each(['issuer', 'client', 'generation', 'owner', 'instance', 'scope'])(
        'refuses confirmation after the Cloud %s authority is replaced',
        async (authority) => {
          const { auth } = setup(false);
          idClaims.frameleaf_role = 'admin';
          const { confirmToken } = await sut.link(auth, { ...callbackDto, preview: true }, {});
          const link = linkRecord();
          metadata.set(SystemMetadataKey.FrameleafCloudLink, {
            ...link,
            ...(authority === 'generation' && { linkedAt: '2026-10-03T12:01:00.000Z' }),
            ...(authority === 'owner' && { accountId: 'replacement-owner' }),
            ...(authority === 'instance' && { instanceId: 'replacement-instance' }),
            oidc: {
              ...link.oidc,
              ...(authority === 'issuer' && { issuer: `${cloud.url}/replacement-issuer` }),
              ...(authority === 'client' && { clientId: 'replacement-client' }),
              ...(authority === 'scope' && { scope: 'openid email' }),
            },
          });

          await expect(sut.confirmLink(auth, { confirmToken: confirmToken! })).rejects.toThrow('not valid any more');
          expect(mocks.frameleafAccount.upsertLink).not.toHaveBeenCalled();
          expect(mocks.user.update).not.toHaveBeenCalled();
          expect(mocks.adminAudit.create).not.toHaveBeenCalled();
          expect(mocks.notification.create).not.toHaveBeenCalled();
          expect(mocks.websocket.clientSend).not.toHaveBeenCalled();
        },
      );

      it('refuses an old preview after unlinking and relinking the same issuer and client', async () => {
        const { auth } = setup(false);
        idClaims.frameleaf_role = 'admin';
        const { confirmToken } = await sut.link(auth, { ...callbackDto, preview: true }, {});
        metadata.set(SystemMetadataKey.FrameleafCloudLink, { ...linkRecord(), status: 'unlinked' });
        await expect(sut.confirmLink(auth, { confirmToken: confirmToken! })).rejects.toThrow('not available');
        metadata.set(SystemMetadataKey.FrameleafCloudLink, {
          ...linkRecord(),
          linkedAt: '2026-10-03T12:02:00.000Z',
        });

        await expect(sut.confirmLink(auth, { confirmToken: confirmToken! })).rejects.toThrow('not valid any more');
        expect(mocks.frameleafAccount.upsertLink).not.toHaveBeenCalled();
        expect(mocks.user.update).not.toHaveBeenCalled();
        expect(mocks.adminAudit.create).not.toHaveBeenCalled();
        expect(mocks.notification.create).not.toHaveBeenCalled();
      });

      it('allows confirmation after routine link contact metadata changes', async () => {
        const { auth } = setup(false);
        idClaims.frameleaf_role = 'admin';
        const { confirmToken } = await sut.link(auth, { ...callbackDto, preview: true }, {});
        metadata.set(SystemMetadataKey.FrameleafCloudLink, {
          ...linkRecord(),
          lastContactAt: '2026-10-03T12:03:00.000Z',
          accountLabel: 'Updated display label',
        });

        await expect(sut.confirmLink(auth, { confirmToken: confirmToken! })).resolves.toMatchObject({
          linked: true,
          roleChange: 'granted-admin',
          isAdmin: true,
        });
      });

      it.each(['unlinked', 'revoked'] as const)(
        'refuses a confirmation whose account lookup waits until real Cloud %s cleanup finishes',
        async (status) => {
          const { auth } = setup(false);
          const { cloudAuthority } = shareAuthorityFence();
          idClaims.frameleaf_role = 'admin';
          const { confirmToken } = await sut.link(auth, { ...callbackDto, preview: true }, {});
          const { promise: entered, resolve: lookupEntered } = Promise.withResolvers<void>();
          const { promise: lookup, resolve: releaseLookup } = Promise.withResolvers<void>();
          mocks.frameleafAccount.getLinkBySub.mockImplementationOnce(async () => {
            lookupEntered();
            await lookup;
            return;
          });
          const refused = expect(sut.confirmLink(auth, { confirmToken: confirmToken! })).rejects.toThrow(
            'not available',
          );
          await entered;

          await cloudAuthority.clearLink(cloud.url, linkRecord() as FrameleafCloudLink, status);
          expect(metadata.get(SystemMetadataKey.FrameleafCloudLink)).toMatchObject({ status });
          expect(mocks.frameleafAccount.deleteAllLinks).toHaveBeenCalledOnce();
          // Cloud cleanup has its own broadcasts; no subsequent write may come from this confirmation.
          vi.clearAllMocks();
          releaseLookup();

          await refused;
          expect(mocks.frameleafAccount.upsertLink).not.toHaveBeenCalled();
          expect(mocks.user.update).not.toHaveBeenCalled();
          expect(mocks.adminAudit.create).not.toHaveBeenCalled();
          expect(mocks.notification.create).not.toHaveBeenCalled();
          expect(mocks.websocket.clientSend).not.toHaveBeenCalled();
        },
      );

      it('refuses a confirmation if the real authority writer replaces its generation during account lookup', async () => {
        const { auth } = setup(false);
        const { cloudAuthority } = shareAuthorityFence();
        idClaims.frameleaf_role = 'admin';
        const { confirmToken } = await sut.link(auth, { ...callbackDto, preview: true }, {});
        const { promise: entered, resolve: lookupEntered } = Promise.withResolvers<void>();
        const { promise: lookup, resolve: releaseLookup } = Promise.withResolvers<void>();
        mocks.frameleafAccount.getLinkBySub.mockImplementationOnce(async () => {
          lookupEntered();
          await lookup;
          return;
        });
        const refused = expect(sut.confirmLink(auth, { confirmToken: confirmToken! })).rejects.toThrow(
          'not valid any more',
        );
        await entered;
        await cloudAuthority.saveLink(
          { ...linkRecord(), linkedAt: '2026-10-03T12:04:00.000Z' } as FrameleafCloudLink,
          null,
          { replaceAuthority: true },
        );
        releaseLookup();

        await refused;
        expect(mocks.frameleafAccount.upsertLink).not.toHaveBeenCalled();
        expect(mocks.user.update).not.toHaveBeenCalled();
        expect(mocks.adminAudit.create).not.toHaveBeenCalled();
        expect(mocks.notification.create).not.toHaveBeenCalled();
        expect(mocks.websocket.clientSend).not.toHaveBeenCalled();
      });

      it.each(['success', 'failure'] as const)(
        'does not resurrect authority when a delayed heartbeat %s finishes after unlink',
        async (outcome) => {
          const { auth } = setup(false);
          const { cloudAuthority, cloudService } = shareAuthorityFence();
          idClaims.frameleaf_role = 'admin';
          const { confirmToken } = await sut.link(auth, { ...callbackDto, preview: true }, {});
          const heartbeatService = cloudService as unknown as {
            apiToken: () => Promise<unknown>;
            removeRetiredKey: () => Promise<void>;
            rotateAfterDamagedKey: (
              url: string,
              document: unknown,
              link: FrameleafCloudLink,
            ) => Promise<FrameleafCloudLink>;
          };
          vi.spyOn(heartbeatService, 'apiToken').mockResolvedValue({
            document: cloudContractFixture('instance/discovery.json'),
            token: { signer: { kid: 'test-heartbeat-key' } },
          });
          vi.spyOn(cloudService, 'buildHeartbeatPayload').mockResolvedValue({} as never);
          vi.spyOn(heartbeatService, 'removeRetiredKey').mockResolvedValue();
          vi.spyOn(heartbeatService, 'rotateAfterDamagedKey').mockImplementation((_url, _document, link) =>
            Promise.resolve(link),
          );
          const { promise: entered, resolve: remoteEntered } = Promise.withResolvers<void>();
          const { promise: remote, resolve: releaseRemote } = Promise.withResolvers<void>();
          mocks.frameleafCloud.requestJson.mockImplementationOnce(async () => {
            remoteEntered();
            await remote;
            if (outcome === 'failure') {
              throw new Error('Delayed heartbeat network failure');
            }
            return {
              nextHeartbeatSec: 300,
              cloneSuspected: false,
              servicesChanged: false,
              entitlementsChanged: false,
              commands: [],
              notices: [],
            } as never;
          });
          const heartbeat = cloudAuthority.checkIn(cloud.url, linkRecord() as FrameleafCloudLink);
          await entered;
          await cloudAuthority.clearLink(cloud.url, linkRecord() as FrameleafCloudLink, 'unlinked');
          expect(mocks.frameleafAccount.deleteAllLinks).toHaveBeenCalledOnce();
          vi.clearAllMocks();
          releaseRemote();

          await expect(heartbeat).resolves.toBe(outcome === 'success' ? JobStatus.Skipped : JobStatus.Failed);
          expect(metadata.get(SystemMetadataKey.FrameleafCloudLink)).toMatchObject({ status: 'unlinked' });
          expect(mocks.systemMetadata.set).not.toHaveBeenCalledWith(
            SystemMetadataKey.FrameleafCloudLink,
            expect.anything(),
          );
          await expect(sut.confirmLink(auth, { confirmToken: confirmToken! })).rejects.toThrow('not available');
          expect(mocks.frameleafAccount.upsertLink).not.toHaveBeenCalled();
          expect(mocks.user.update).not.toHaveBeenCalled();
          expect(mocks.adminAudit.create).not.toHaveBeenCalled();
          expect(mocks.notification.create).not.toHaveBeenCalled();
          expect(mocks.websocket.clientSend).not.toHaveBeenCalled();
        },
      );

      it('accepts routine writes for the current generation and fresh approved authority replacement', async () => {
        const { auth } = setup(false);
        const { cloudAuthority } = shareAuthorityFence();
        idClaims.frameleaf_role = 'admin';
        const preview = await sut.link(auth, { ...callbackDto, preview: true }, {});
        await expect(
          cloudAuthority.saveLink(
            { ...linkRecord(), lastContactAt: '2026-10-03T12:05:00.000Z' } as FrameleafCloudLink,
            null,
          ),
        ).resolves.toBe(true);
        await expect(sut.confirmLink(auth, { confirmToken: preview.confirmToken! })).resolves.toMatchObject({
          linked: true,
        });

        const replacement = { ...linkRecord(), linkedAt: '2026-10-03T12:06:00.000Z' } as FrameleafCloudLink;
        await expect(cloudAuthority.saveLink(replacement, null)).resolves.toBe(false);
        metadata.delete(SystemMetadataKey.FrameleafCloudLink);
        await expect(cloudAuthority.saveLink(replacement, null, { replaceAuthority: true })).resolves.toBe(true);
        const renewed = await sut.link(auth, { ...callbackDto, preview: true }, {});
        await expect(sut.confirmLink(auth, { confirmToken: renewed.confirmToken! })).resolves.toMatchObject({
          linked: true,
        });
      });

      it('holds the shared authority fence through linking, promotion, audit and notification writes', async () => {
        const { user, auth } = setup(false);
        const { held } = shareAuthorityFence();
        idClaims.frameleaf_role = 'admin';
        const { confirmToken } = await sut.link(auth, { ...callbackDto, preview: true }, {});
        mocks.frameleafAccount.upsertLink.mockImplementation((row) => {
          expect(held.getStore()).toContain(DatabaseLock.FrameleafLinkAuthority);
          return Promise.resolve({ ...row, access: row.access ?? null, linkedAt: new Date(), lastSignInAt: null });
        });
        mocks.user.update.mockImplementation((id, change) => {
          expect(held.getStore()).toContain(DatabaseLock.FrameleafLinkAuthority);
          return Promise.resolve({ ...user, ...change, id } as never);
        });
        mocks.adminAudit.create.mockImplementation(() => {
          expect(held.getStore()).toContain(DatabaseLock.FrameleafLinkAuthority);
          return Promise.resolve(undefined as never);
        });
        mocks.notification.create.mockImplementation((value) => {
          expect(held.getStore()).toContain(DatabaseLock.FrameleafLinkAuthority);
          return Promise.resolve({
            id: 'notification-1',
            createdAt: new Date(),
            readAt: null,
            data: null,
            ...value,
          } as never);
        });
        mocks.websocket.clientSend.mockImplementation(() => {
          expect(held.getStore()).toContain(DatabaseLock.FrameleafLinkAuthority);
        });

        await expect(sut.confirmLink(auth, { confirmToken: confirmToken! })).resolves.toMatchObject({
          linked: true,
          roleChange: 'granted-admin',
        });
        expect(mocks.user.update).toHaveBeenCalledWith(user.id, { isAdmin: true });
        expect(mocks.adminAudit.create).toHaveBeenCalled();
        expect(mocks.notification.create).toHaveBeenCalled();
        expect(mocks.websocket.clientSend).toHaveBeenCalled();
      });

      it('refuses a tampered confirm token, or one from another session or person', async () => {
        const { auth } = setup(false);
        idClaims.frameleaf_role = 'user';
        const { confirmToken } = await sut.link(auth, { ...callbackDto, preview: true }, {});
        const [payload, mac] = confirmToken!.split('.', 2);
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
        const forged = `${Buffer.from(JSON.stringify({ ...claims, role: 'admin' })).toString('base64url')}.${mac}`;

        await expect(sut.confirmLink(auth, { confirmToken: forged })).rejects.toThrow('not valid any more');
        const otherSession = AuthFactory.from(auth.user).session({ id: 'session-2' }).build();
        await expect(sut.confirmLink(otherSession, { confirmToken: confirmToken! })).rejects.toThrow(
          'not valid any more',
        );
        expect(mocks.frameleafAccount.upsertLink).not.toHaveBeenCalled();
      });
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
      // this session stays signed in but is no longer tagged, so it cannot hand itself over
      expect(mocks.frameleafAccount.deleteSessions).toHaveBeenCalledWith(['session-1', 'session-2']);
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
