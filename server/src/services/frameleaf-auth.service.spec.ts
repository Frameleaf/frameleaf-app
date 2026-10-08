import { type JWK, SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, importJWK, jwtVerify } from 'jose';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrameleafInstanceIdentity } from 'src/types.js';
import { FrameleafTokenExchangeErrorCode } from 'src/dtos/frameleaf-auth.dto.js';
import { AdminAuditAction, DatabaseLock, SystemMetadataKey } from 'src/enum.js';
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
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';
import { type ExchangeTokenOptions, mintExchangeToken } from 'test/fixtures/frameleaf-token-exchange.js';
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
  let edKey: CryptoKey;
  let edJwk: JWK;
  let idTokenAlg: 'RS256' | 'EdDSA';
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
        .setSubject('fl-sub')
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
    mocks.systemMetadata.set.mockImplementation((key, value) => {
      metadata.set(key, value);
      return Promise.resolve();
    });
    mocks.database.withLock.mockImplementation((_lock, callback) => callback() as never);
    mocks.session.create.mockImplementation((row) => Promise.resolve({ id: 'session-1', ...row } as never));
    mocks.frameleafAccount.upsertLink.mockImplementation((row) =>
      Promise.resolve({
        ...row,
        access: row.access ?? null,
        linkedAt: new Date(),
        lastSignInAt: null,
        scopeGrantedAt: null,
      }),
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

    describe('frameleaf_access viewer: server-level Viewer (FL-235)', () => {
      const createViewer = async () => {
        const created = UserFactory.create({ email: 'remote@example.test', isAdmin: false });
        mocks.frameleafAccount.getLinkBySub.mockResolvedValue(void 0);
        mocks.user.getByEmail.mockResolvedValue(void 0);
        mocks.user.getAdmin.mockResolvedValue(UserFactory.create({ isAdmin: true }));
        mocks.clusterGroup.create.mockResolvedValue({ id: 'group-1' } as never);
        mocks.user.create.mockResolvedValue(created as never);
        await sut.callback(callbackDto, {}, loginDetails);
        return created;
      };

      beforeEach(() => {
        idClaims.frameleaf_access = 'viewer';
        mocks.frameleafAccount.getUserIdsByAccess.mockResolvedValue(['owner-1']);
      });

      it('records the access and shares the server owner’s library with a new viewer', async () => {
        const created = await createViewer();

        expect(mocks.frameleafAccount.upsertLink).toHaveBeenCalledWith(
          expect.objectContaining({ userId: created.id, access: 'viewer' }),
        );
        expect(mocks.frameleafAccount.touchLink).toHaveBeenCalledWith(
          created.id,
          expect.objectContaining({ access: 'viewer' }),
        );
        expect(mocks.frameleafAccount.getUserIdsByAccess).toHaveBeenCalledWith('owner');
        expect(mocks.partner.create).toHaveBeenCalledWith({
          sharedById: 'owner-1',
          sharedWithId: created.id,
          inTimeline: true,
        });
        expect(mocks.frameleafAccount.markScopeGranted).toHaveBeenCalledWith(created.id);
      });

      it('never makes a viewer an administrator, whatever frameleaf_role says', async () => {
        idClaims.frameleaf_role = 'admin';
        await createViewer();
        expect(mocks.user.create).toHaveBeenCalledWith(expect.objectContaining({ isAdmin: false }));
      });

      it('keeps the scope the library owners chose at later sign-ins', async () => {
        const user = UserFactory.create({ isAdmin: false });
        mocks.frameleafAccount.getLinkBySub.mockResolvedValue({
          userId: user.id,
          sub: 'fl-sub',
          access: 'viewer',
          scopeGrantedAt: new Date(),
        } as never);
        mocks.user.get.mockResolvedValue(user as never);

        await sut.callback(callbackDto, {}, loginDetails);
        expect(mocks.partner.create).not.toHaveBeenCalled();
        expect(mocks.frameleafAccount.markScopeGranted).not.toHaveBeenCalled();
      });

      it('grants the scope again to a viewer whose access was revoked and who was invited again', async () => {
        const user = UserFactory.create({ isAdmin: false });
        mocks.frameleafAccount.getLinkBySub.mockResolvedValue({
          userId: user.id,
          sub: 'fl-sub',
          access: 'viewer',
          scopeGrantedAt: null,
        } as never);
        mocks.user.get.mockResolvedValue(user as never);

        await sut.callback(callbackDto, {}, loginDetails);
        expect(mocks.partner.create).toHaveBeenCalledWith(expect.objectContaining({ sharedWithId: user.id }));
      });

      it('lifts the restriction when the cloud raises the share to editor', async () => {
        const user = UserFactory.create({ isAdmin: false });
        idClaims.frameleaf_access = 'editor';
        mocks.frameleafAccount.getLinkBySub.mockResolvedValue({
          userId: user.id,
          sub: 'fl-sub',
          access: 'viewer',
          scopeGrantedAt: new Date(),
        } as never);
        mocks.user.get.mockResolvedValue(user as never);

        await sut.callback(callbackDto, {}, loginDetails);
        expect(mocks.frameleafAccount.touchLink).toHaveBeenCalledWith(
          user.id,
          expect.objectContaining({ access: 'editor' }),
        );
        expect(mocks.partner.create).not.toHaveBeenCalled();
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
      expect(mocks.frameleafAccount.upsertLink).toHaveBeenCalledWith(
        expect.objectContaining({ userId: created.id, sub: 'fl-sub', autoRegistered: true, role: 'user' }),
      );
      expect(mocks.frameleafAccount.tagSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session-1', userId: created.id, sid: 'fl-app-sid', sub: 'fl-sub' }),
      );
      expect(mocks.frameleafAccount.touchLink).toHaveBeenCalledWith(
        created.id,
        expect.objectContaining({ role: 'user' }),
      );
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

    it('records the access the cloud gives the linked account on this server (FL-235)', async () => {
      const user = UserFactory.create();
      const auth = AuthFactory.from(user).build();
      idClaims.frameleaf_access = 'viewer';
      mocks.frameleafAccount.getLinkBySub.mockResolvedValue(void 0);
      mocks.frameleafAccount.getUserIdsByAccess.mockResolvedValue(['owner-1']);
      mocks.user.get.mockResolvedValue(user as never);

      await sut.link(auth, callbackDto, {});
      expect(mocks.frameleafAccount.upsertLink).toHaveBeenCalledWith(
        expect.objectContaining({ userId: user.id, access: 'viewer' }),
      );
      expect(mocks.partner.create).toHaveBeenCalledWith(expect.objectContaining({ sharedWithId: user.id }));
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
