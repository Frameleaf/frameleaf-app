import { BadRequestException, ConflictException } from '@nestjs/common';
import { decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrameleafLicenseStore } from 'src/types.js';
import { AdminAuditAction, JobStatus, NotificationLevel, SystemMetadataKey, UserMetadataKey } from 'src/enum.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  FrameleafLicenseService,
  IDENTITY_KEY_MISMATCH_MESSAGE,
  LINK_CODE_INVALID_MESSAGE,
  LINK_CODE_PASTE_KEY,
  LINK_CODE_UNAVAILABLE_MESSAGE,
} from 'src/services/frameleaf-license.service.js';
import { ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';
import { FakeCloud, FakeCloudRequest, startFakeCloud, tokenAnswer, tokenNameOf } from 'test/fake-frameleaf-cloud.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';
import { makeLicenseSigner, signLicenseCertificate } from 'test/fixtures/frameleaf-license.fixture.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const SERVER_KEY = 'FL-S8NL-49G8-J583';
const PERSONAL_KEY = 'FL-IC8Q-BT2Q-8EL6';

describe(FrameleafLicenseService.name, () => {
  let sut: FrameleafLicenseService;
  let mocks: ServiceMocks;
  let cloud: FakeCloud;
  let identityDir: string;
  let metadata: Map<string, unknown>;
  let cloudUrl: string | null;
  const signer = makeLicenseSigner('active');
  const spare = makeLicenseSigner('spare');
  const now = () => Math.floor(Date.now() / 1000);

  const store = () => metadata.get(SystemMetadataKey.FrameleafLicense) as FrameleafLicenseStore | undefined;
  const instanceId = () => (metadata.get(SystemMetadataKey.FrameleafInstance) as { instanceId: string }).instanceId;
  const certificate = (claims: Record<string, unknown> = {}) =>
    signLicenseCertificate(signer, now(), { iid: instanceId(), ...claims });

  const link = () =>
    metadata.set(SystemMetadataKey.FrameleafCloudLink, {
      status: 'linked',
      cloudUrl,
      instanceId: instanceId(),
      accountId: 'account-1',
    });

  /**
   * FL-177 (as-built decision #28): an unlinked server's activation travels as a compact JWS signed by
   * its identity key (`kid` = the `jkt`), bound to the activation address and short-lived. It is not
   * a DPoP request: no token and no `DPoP` header (FL-178).
   */
  const signedActivation = async (request: FakeCloudRequest) => {
    expect(request.headers['content-type']).toBe('application/jose');
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers.dpop).toBeUndefined();
    const identity = metadata.get(SystemMetadataKey.FrameleafInstance) as {
      kid: string;
      publicJwk: Record<string, string>;
    };
    // verified the way the cloud does for a server it holds no key for: with the header's own key
    const header = decodeProtectedHeader(request.body) as { jwk?: Record<string, string>; kid?: string };
    expect(Object.keys(header.jwk ?? {}).sort()).toEqual(['crv', 'kty', 'x']);
    expect(header.jwk).toEqual(identity.publicJwk);
    expect(ed25519Thumbprint(header.jwk as { crv: string; kty: string; x: string })).toBe(header.kid);
    const { payload, protectedHeader } = await jwtVerify(request.body, await importJWK(header.jwk!, 'EdDSA'), {
      audience: `${cloud.url}/api/v1/licenses/activate`,
    });
    expect(protectedHeader).toMatchObject({ alg: 'EdDSA', kid: identity.kid });
    expect((payload.fingerprint as { jkt: string }).jkt).toBe(header.kid);
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(120);
    expect(payload.jti).toEqual(expect.any(String));
    return payload as Record<string, any>;
  };

  const serveToken = () => cloud.on('POST /id/token', (request) => tokenAnswer(request));

  beforeEach(async () => {
    cloud = await startFakeCloud();
    identityDir = await mkdtemp(join(tmpdir(), 'frameleaf-identity-'));
    cloudUrl = cloud.url;
    metadata = new Map();
    ({ sut, mocks } = newTestService(FrameleafLicenseService, {
      frameleafCloud: new FrameleafCloudRepository(LoggingRepository.create()),
      instanceIdentity: new InstanceIdentityRepository(),
    }));
    (sut as unknown as { licenseKeys: unknown }).licenseKeys = [signer.key, spare.key];
    const baseEnv = mocks.config.getEnv();
    mocks.config.getEnv.mockImplementation(
      () =>
        ({
          ...baseEnv,
          frameleafCloud: { ...baseEnv.frameleafCloud, url: cloudUrl, identityDir },
        }) as never,
    );
    mocks.systemMetadata.get.mockImplementation((key) => Promise.resolve((metadata.get(key) ?? null) as never));
    mocks.systemMetadata.set.mockImplementation((key, value) => {
      metadata.set(key, value);
      return Promise.resolve();
    });
    mocks.database.withLock.mockImplementation((_lock, callback) => callback() as never);
    mocks.user.getAdmins.mockResolvedValue([{ id: authStub.admin.user.id, name: 'Admin' }] as never);
    mocks.event.emit.mockResolvedValue(undefined as never);
    // create the identity so certificates can be bound to it
    await new InstanceIdentityRepository()
      .loadOrCreate(identityDir, null)
      .then((identity) => metadata.set(SystemMetadataKey.FrameleafInstance, identity));
  });

  afterEach(async () => {
    await cloud.close();
    await rm(identityDir, { recursive: true, force: true });
  });

  describe('status', () => {
    it('reports no licence, never gating anything local', async () => {
      await expect(sut.getStatus()).resolves.toMatchObject({
        state: 'none',
        licensed: false,
        entitlements: {
          frameleafCloud: false,
          remoteAccess: false,
          cloudMl: false,
          cloudBackup: false,
          supporter: false,
        },
        key: null,
        plan: null,
        configured: true,
        linked: false,
      });
    });
  });

  describe('activate (server key)', () => {
    it('refuses a malformed, upstream or personal key before contacting anything (FL-170, FL-171)', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      await expect(sut.activate(authStub.admin, { key: 'IMSV-AAAA-BBBB-CCCC-DDDD' })).rejects.toThrow(
        'not a Frameleaf licence key',
      );
      await expect(sut.activate(authStub.admin, { key: 'FL-S8NL-49G8-J58V' })).rejects.toThrow('typo');
      await expect(sut.activate(authStub.admin, { key: PERSONAL_KEY })).rejects.toThrow('personal key');
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('activates publicly when not linked, with the instance fingerprint, and stores the verified certificate', async () => {
      cloud.on('POST /api/v1/licenses/activate', () => ({
        status: 200,
        body: {
          certificate: certificate({
            ent: ['SUPPORTER_SERVER'],
            lic_exp: null,
            lic: { id: 'lic-1', last4: 'J583', kind: 'server' },
          }),
          activationId: 'act-1',
        },
      }));

      const status = await sut.activate(authStub.admin, { key: SERVER_KEY });

      const request = cloud.requests.find(({ path }) => path === '/api/v1/licenses/activate')!;
      const identity = metadata.get(SystemMetadataKey.FrameleafInstance) as { kid: string };
      await expect(signedActivation(request)).resolves.toMatchObject({
        key: SERVER_KEY,
        fingerprint: { instanceId: instanceId(), jkt: identity.kid },
        instanceName: expect.any(String),
      });
      expect(status).toMatchObject({
        state: 'active',
        kind: 'server',
        keyHint: 'J583',
        licensed: true,
        entitlements: { supporter: true, remoteAccess: false },
        key: { kind: 'server', source: 'key', keyHint: 'J583', expiresAt: null },
      });
      expect(JSON.stringify(store())).not.toContain(SERVER_KEY);
      expect(mocks.adminAudit.create).toHaveBeenCalledWith([
        expect.objectContaining({ action: AdminAuditAction.LicenseActivated, detail: 'J583' }),
      ]);
      expect(cloud.requests.some(({ path }) => path.includes('futo'))).toBe(false);
    });

    it('activates with the instance token when linked', async () => {
      link();
      serveToken();
      cloud.on('POST /api/v1/licenses/activate', () => ({
        status: 200,
        body: { certificate: certificate({ ent: ['SUPPORTER_SERVER'], lic_exp: null, lic: { kind: 'server' } }) },
      }));
      await sut.activate(authStub.admin, { key: SERVER_KEY });
      const request = cloud.requests.find(({ path }) => path === '/api/v1/licenses/activate')!;
      // FL-178: a DPoP-bound instance token and a proof by the identity key (checked by the fake cloud)
      expect(tokenNameOf(request)).toBe('api-token');
      expect(request.dpop).toMatchObject({
        claims: { htm: 'POST', htu: `${cloud.url}/api/v1/licenses/activate`, ath: expect.any(String) },
      });
      // a linked server sends the plain JSON body; its token already proves who it is, and the
      // fingerprint names the key the token is bound to
      expect(request.headers['content-type']).toBe('application/json');
      const identity = metadata.get(SystemMetadataKey.FrameleafInstance) as { kid: string };
      expect(request.dpop!.jkt).toBe(identity.kid);
      expect(request.json()).toMatchObject({
        key: SERVER_KEY,
        fingerprint: { instanceId: instanceId(), jkt: identity.kid },
      });
    });

    it('never activates without the identity key’s signature when not linked (FL-177)', async () => {
      cloud.on('POST /api/v1/licenses/activate', (request) =>
        request.headers['content-type'] === 'application/jose'
          ? {
              status: 200,
              body: { certificate: certificate({ ent: ['SUPPORTER_SERVER'], lic_exp: null, lic: { kind: 'server' } }) },
            }
          : { status: 401, body: { code: 'unauthorized', message: 'Sign the activation.' } },
      );
      await expect(sut.activate(authStub.admin, { key: SERVER_KEY })).resolves.toMatchObject({ kind: 'server' });
      const request = cloud.requests.find(({ path }) => path === '/api/v1/licenses/activate')!;
      expect(request.body.split('.')).toHaveLength(3);
    });

    it('refuses a certificate for another server or signed by an unknown key', async () => {
      cloud.on('POST /api/v1/licenses/activate', () => ({
        status: 200,
        body: { certificate: certificate({ iid: 'another-server', lic: { kind: 'server' } }) },
      }));
      await expect(sut.activate(authStub.admin, { key: SERVER_KEY })).rejects.toThrow('different server');

      const stranger = makeLicenseSigner('active');
      cloud.on('POST /api/v1/licenses/activate', () => ({
        status: 200,
        body: { certificate: signLicenseCertificate(stranger, now(), { iid: instanceId(), lic: { kind: 'server' } }) },
      }));
      await expect(sut.activate(authStub.admin, { key: SERVER_KEY })).rejects.toThrow('not a valid Frameleaf licence');
      expect(store()).toBeUndefined();
    });

    it('passes on the cloud’s refusal in plain words', async () => {
      cloud.on('POST /api/v1/licenses/activate', () => ({
        status: 404,
        body: { code: 'unknown-key', message: 'This key was not found.' },
      }));
      await expect(sut.activate(authStub.admin, { key: SERVER_KEY })).rejects.toThrow('This key was not found.');
    });

    it('explains an activation refused because this server’s ID is registered with another key (FL-177)', async () => {
      cloud.on('POST /api/v1/licenses/activate', () => ({
        status: 409,
        body: { code: 'instance-id-taken', message: 'refused', retryable: false, requestId: 'req_01J8ZK3M4N5P6Q7R' },
      }));
      await expect(sut.activate(authStub.admin, { key: SERVER_KEY })).rejects.toThrow(IDENTITY_KEY_MISMATCH_MESSAGE);
      await expect(sut.activate(authStub.admin, { key: SERVER_KEY })).rejects.toBeInstanceOf(ConflictException);
      expect(IDENTITY_KEY_MISMATCH_MESSAGE).not.toMatch(/please|successfully|simply/i);
      expect(store()).toBeUndefined();
    });

    it('says to use a file when Frameleaf Cloud is not set up', async () => {
      cloudUrl = null;
      await expect(sut.activate(authStub.admin, { key: SERVER_KEY })).rejects.toThrow('Install a licence file');
    });
  });

  describe('licence files', () => {
    it('installs a plan certificate from a file, raw or wrapped in JSON, verified with the spare key too', async () => {
      const plan = signLicenseCertificate(spare, now(), { iid: instanceId() });
      await expect(
        sut.installCertificate(authStub.admin, { certificate: JSON.stringify({ certificate: plan }) }),
      ).resolves.toMatchObject({
        state: 'active',
        kind: 'plan',
        offline: true,
        entitlements: { remoteAccess: true, cloudBackup: true, cloudMl: true, frameleafCloud: true },
        plan: { source: 'file', kind: 'plan' },
      });
    });

    it('refuses a file for another server, an expired one, and one that is not a licence', async () => {
      await expect(
        sut.installCertificate(authStub.admin, { certificate: certificate({ iid: 'someone-else' }) }),
      ).rejects.toThrow('different server');
      await expect(
        sut.installCertificate(authStub.admin, { certificate: certificate({ exp: now() - 10 }) }),
      ).rejects.toThrow('expired');
      await expect(sut.installCertificate(authStub.admin, { certificate: '{"format":"other"}' })).rejects.toThrow(
        'not a Frameleaf licence file',
      );
    });

    describe('extra licence keys (integration builds only, owner decision 2026-09-27)', () => {
      const dev = makeLicenseSigner('active');
      let jwksFile: string;
      const devCertificate = () => signLicenseCertificate(dev, now(), { iid: instanceId() });
      const withBuild = (channel: 'release' | 'integration', path: string | null = jwksFile) => {
        (sut as unknown as { buildChannel: string }).buildChannel = channel;
        const env = mocks.config.getEnv();
        mocks.config.getEnv.mockReturnValue({
          ...env,
          frameleafCloud: { ...env.frameleafCloud, licenseExtraJwksFile: path },
        } as never);
        sut.onBootstrapLicenseKeys();
      };

      beforeEach(async () => {
        jwksFile = join(identityDir, 'dev-keys.json');
        await writeFile(
          jwksFile,
          JSON.stringify({
            keys: [{ kty: 'OKP', crv: 'Ed25519', x: dev.key.x, kid: dev.key.kid, alg: 'EdDSA', use: 'sig' }],
          }),
        );
      });

      it('a release build ignores FRAMELEAF_LICENSE_EXTRA_JWKS_FILE and refuses the dev-signed certificate', async () => {
        withBuild('release');
        expect(mocks.logger.warn).toHaveBeenCalledWith(
          expect.stringMatching(/is set .* but ignored: this is a release build/),
        );
        await expect(sut.installCertificate(authStub.admin, { certificate: devCertificate() })).rejects.toThrow(
          'not a valid Frameleaf licence',
        );
        expect(store()).toBeUndefined();
      });

      it('an integration build logs a warning at startup and accepts a certificate the extra key signed', async () => {
        withBuild('integration');
        expect(mocks.logger.warn).toHaveBeenCalledWith(
          expect.stringContaining(`Pre-release build trusting extra licence keys from ${jwksFile}`),
        );
        await expect(sut.installCertificate(authStub.admin, { certificate: devCertificate() })).resolves.toMatchObject({
          state: 'active',
          kind: 'plan',
        });
        expect(store()?.plan?.kid).toBe(dev.key.kid);
      });

      it('an integration build still verifies the pinned production keys', async () => {
        withBuild('integration');
        await expect(sut.installCertificate(authStub.admin, { certificate: certificate() })).resolves.toMatchObject({
          state: 'active',
        });
        expect(store()?.plan?.kid).toBe(signer.key.kid);
      });

      it('an integration build with a bad file trusts nothing extra and says why', async () => {
        await writeFile(
          jwksFile,
          JSON.stringify({ keys: [{ kty: 'OKP', crv: 'Ed25519', x: dev.key.x, kid: dev.key.kid, d: 'x' }] }),
        );
        withBuild('integration');
        expect(mocks.logger.error).toHaveBeenCalledWith(
          expect.stringMatching(/was rejected, so no extra licence keys are trusted: .*private key material/),
        );
        await expect(sut.installCertificate(authStub.admin, { certificate: devCertificate() })).rejects.toThrow(
          'not a valid Frameleaf licence',
        );
        await expect(sut.installCertificate(authStub.admin, { certificate: certificate() })).resolves.toMatchObject({
          state: 'active',
        });
      });

      it('an integration build without the setting trusts only the pinned keys and logs nothing', async () => {
        withBuild('integration', null);
        expect(mocks.logger.warn).not.toHaveBeenCalled();
        expect(mocks.logger.error).not.toHaveBeenCalled();
        await expect(sut.installCertificate(authStub.admin, { certificate: devCertificate() })).rejects.toThrow(
          'not a valid Frameleaf licence',
        );
      });
    });
  });

  describe('removal', () => {
    beforeEach(async () => {
      cloud.on('POST /api/v1/licenses/activate', () => ({
        status: 200,
        body: {
          certificate: certificate({ ent: ['SUPPORTER_SERVER'], lic_exp: null, lic: { id: 'lic-1', kind: 'server' } }),
          activationId: 'act-1',
        },
      }));
      await sut.activate(authStub.admin, { key: SERVER_KEY });
      await sut.installCertificate(authStub.admin, { certificate: certificate() });
    });

    it('removes the key, deactivating it with the cloud, and keeps the plan', async () => {
      cloud.on('POST /api/v1/licenses/deactivate', () => ({ status: 200, body: {} }));
      const status = await sut.removeKey(authStub.admin);
      // shape matches the golden licence/deactivate-request.json fixture (FL-184, FC-22 final)
      expect(cloud.requests.find(({ path }) => path === '/api/v1/licenses/deactivate')?.json()).toMatchObject({
        activationId: 'act-1',
        licenseId: 'lic-1',
        fingerprint: { instanceId: instanceId() },
      });
      expect(status).toMatchObject({
        key: null,
        plan: { kind: 'plan' },
        entitlements: { supporter: false, remoteAccess: true },
      });
      expect(mocks.adminAudit.create).toHaveBeenCalledWith([
        expect.objectContaining({ action: AdminAuditAction.LicenseRemoved }),
      ]);
    });

    it('removes the key locally even when the cloud cannot be reached', async () => {
      cloud.on('POST /api/v1/licenses/deactivate', () => ({ status: 503, body: { code: 'down', message: 'down' } }));
      await expect(sut.removeKey(authStub.admin)).resolves.toMatchObject({ key: null });
    });

    it('removes the plan and keeps the key', async () => {
      await expect(sut.removePlan(authStub.admin)).resolves.toMatchObject({
        plan: null,
        key: { kind: 'server' },
        entitlements: { supporter: true, remoteAccess: false },
      });
    });
  });

  describe('refresh', () => {
    it('replaces the plan certificate from Frameleaf Cloud when linked', async () => {
      link();
      serveToken();
      cloud.on('POST /api/v1/licenses/refresh', () => ({
        status: 200,
        body: { certificates: [certificate({ jti: 'jti-2' })] },
      }));
      const status = await sut.refreshNow();
      const refresh = cloud.requests.find(({ path }) => path === '/api/v1/licenses/refresh')!;
      expect(tokenNameOf(refresh)).toBe('api-token');
      expect(refresh.dpop?.claims.ath).toEqual(expect.any(String));
      expect(status).toMatchObject({ state: 'active', plan: { source: 'account' }, refresh: { lastError: null } });
      expect(store()?.plan?.claims.jti).toBe('jti-2');
    });

    it('schedules the next refresh after discovery’s entitlementRefreshSec and refreshes early when it shrinks (FC-62)', async () => {
      // Refresh stamps milliseconds but schedules in whole seconds. Fix this case's clock and
      // minimum jitter so the existing bounds exercise the exact interval deterministically.
      const now = Math.floor(Date.now() / 1000) * 1000;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      const jitter = vi.spyOn(Math, 'random').mockReturnValue(0);
      try {
        const discovery = cloud.discovery;
        let entitlementRefreshSec = 7200;
        cloud.discovery = () => ({ ...discovery(), intervals: { heartbeatSec: 300, entitlementRefreshSec } });
        link();
        serveToken();
        cloud.on('POST /api/v1/licenses/refresh', () => ({
          status: 200,
          body: { certificates: [certificate({ jti: 'jti-2' })] },
        }));
        await sut.refreshNow();
        const plan = store()!.plan!;
        const due = Date.parse(plan.nextRefreshAt!) - Date.parse(plan.refreshedAt!);
        expect(due).toBeGreaterThanOrEqual(7200 * 1000);
        expect(due).toBeLessThan(7920 * 1000);

        // not due yet: the hourly tick asks nothing
        const refreshes = () => cloud.requests.filter(({ path }) => path === '/api/v1/licenses/refresh').length;
        await sut.handleRefresh();
        expect(refreshes()).toBe(1);

        // staff shorten the interval below the certificate's age: the next tick refreshes
        entitlementRefreshSec = 3600;
        (sut as unknown as { frameleafCloudRepository: { forget(): void } }).frameleafCloudRepository.forget();
        metadata.set(SystemMetadataKey.FrameleafLicense, {
          ...store()!,
          plan: {
            ...plan,
            claims: { ...plan.claims, iat: plan.claims.iat - 5000 },
            refreshedAt: new Date(Date.now() - 5000 * 1000).toISOString(),
          },
        });
        // the discovery copy this process holds is read when the tick runs
        await (
          sut as unknown as { frameleafCloudRepository: { discovery(url: string): Promise<unknown> } }
        ).frameleafCloudRepository.discovery(cloud.url);
        await sut.handleRefresh();
        expect(refreshes()).toBe(2);
      } finally {
        jitter.mockRestore();
        clock.mockRestore();
      }
    });

    describe('the answer replaces every certificate held (FL-185)', () => {
      const keyCertificate = (claims: Record<string, unknown> = {}) =>
        certificate({
          lic: { id: 'licence-1', last4: 'H23J', kind: 'server' },
          ent: ['SUPPORTER_SERVER'],
          lic_exp: null,
          jti: 'key-1',
          ...claims,
        });
      const holdPlanAndKey = async () => {
        await sut.installCertificate(authStub.admin, { certificate: certificate({ jti: 'plan-1' }) });
        await sut.installCertificate(authStub.admin, { certificate: keyCertificate() });
        metadata.set(SystemMetadataKey.FrameleafLicense, {
          ...store()!,
          key: { ...store()!.key!, activationId: 'activation-1' },
        });
        link();
        serveToken();
      };

      it('drops a held key certificate the answer leaves out', async () => {
        await holdPlanAndKey();
        cloud.on('POST /api/v1/licenses/refresh', () => ({
          status: 200,
          body: { certificates: [certificate({ jti: 'plan-2' })] },
        }));

        await sut.refreshNow();

        const refresh = cloud.requests.find(({ path }) => path === '/api/v1/licenses/refresh')!;
        // the list sent is informational: the jtis held, in any order
        expect([...(refresh.json().certificates as string[])].toSorted((a, b) => a.localeCompare(b))).toEqual([
          'key-1',
          'plan-1',
        ]);
        expect(store()?.key).toBeNull();
        expect(store()?.plan).toMatchObject({ claims: { jti: 'plan-2' }, refreshedAt: expect.any(String) });
        await expect(sut.getStatus()).resolves.toMatchObject({ entitlements: { supporter: false }, key: null });
      });

      it('keeps the activation of the key held here when the answer lists it again', async () => {
        await holdPlanAndKey();
        cloud.on('POST /api/v1/licenses/refresh', () => ({
          status: 200,
          body: {
            certificates: [
              certificate({ jti: 'plan-2' }),
              keyCertificate({ lic: { id: 'licence-2', last4: 'K9PQ', kind: 'server' }, jti: 'key-other' }),
              keyCertificate({ jti: 'key-2' }),
            ],
          },
        }));

        await sut.refreshNow();

        expect(store()?.key).toMatchObject({
          source: 'key',
          keyHint: 'H23J',
          activationId: 'activation-1',
          claims: { jti: 'key-2' },
        });
        expect(store()?.plan?.claims.jti).toBe('plan-2');
      });

      it.each([
        ['an empty answer', (): string[] => [], 'does not understand'],
        [
          'an answer without a plan certificate',
          (): string[] => [keyCertificate({ jti: 'key-2' })],
          'without a plan certificate',
        ],
      ])('keeps both certificates and records the error for %s, retrying in an hour', async (_, answer, error) => {
        await holdPlanAndKey();
        cloud.on('POST /api/v1/licenses/refresh', () => ({ status: 200, body: { certificates: answer() } }));

        await expect(sut.handleRefresh({ force: true })).resolves.toBe(JobStatus.Success);

        const held = store()!;
        expect(held.plan).toMatchObject({
          claims: { jti: 'plan-1' },
          lastRefreshError: expect.stringContaining(error),
        });
        expect(held.key).toMatchObject({
          claims: { jti: 'key-1' },
          activationId: 'activation-1',
          lastRefreshError: expect.stringContaining(error),
        });
        const retryIn = Date.parse(held.plan!.nextRefreshAt!) - Date.now();
        expect(retryIn).toBeGreaterThan(55 * 60 * 1000);
        expect(retryIn).toBeLessThanOrEqual(60 * 60 * 1000);
      });
    });

    it('says a file licence is not refreshed online when unlinked', async () => {
      await sut.installCertificate(authStub.admin, { certificate: certificate() });
      await expect(sut.refreshNow()).rejects.toThrow('came from a file');
    });

    it('keeps entitlements in grace while refresh fails, then tells administrators once', async () => {
      link();
      serveToken();
      const expiresAt = now() + 2;
      await sut.installCertificate(authStub.admin, {
        certificate: certificate({ lic_exp: expiresAt, exp: expiresAt, grace_days: 7 }),
      });
      cloud.on('POST /api/v1/licenses/refresh', () => ({ status: 503, body: { code: 'down', message: 'down' } }));
      await new Promise((resolve) => setTimeout(resolve, 2100));

      await expect(sut.handleRefresh({ force: true })).resolves.toBe(JobStatus.Success);
      await expect(sut.getStatus()).resolves.toMatchObject({
        state: 'grace',
        entitlements: { remoteAccess: true },
        refresh: { lastError: expect.stringContaining('down') },
      });
      expect(mocks.event.emit).toHaveBeenCalledWith(
        'AdminNotify',
        expect.objectContaining({
          level: NotificationLevel.Warning,
          dedupeKey: expect.stringContaining('grace'),
          systemTemplate: {
            version: 1,
            key: 'license-grace',
            args: { until: new Date((expiresAt + 7 * 86_400) * 1000).toISOString().slice(0, 10) },
          },
        }),
      );
      mocks.event.emit.mockClear();
      await sut.handleRefresh({ force: true });
      expect(mocks.event.emit).not.toHaveBeenCalled();

      await sut['noticeStateChange'](Date.now() + 8 * 86_400_000);
      await sut['noticeStateChange'](Date.now() + 8 * 86_400_000);
      expect(mocks.event.emit).toHaveBeenCalledTimes(1);
      expect(mocks.event.emit).toHaveBeenCalledWith(
        'AdminNotify',
        expect.objectContaining({
          level: NotificationLevel.Error,
          dedupeKey: expect.stringContaining('expired'),
          systemTemplate: { version: 1, key: 'license-expired', args: {} },
        }),
      );
    }, 10_000);
  });

  describe('products (FL-157, FL-172)', () => {
    it('serves bundled USD prices and the store from FRAMELEAF_CLOUD_URL, with no outbound call', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const products = await sut.getProducts();
      expect(products).toMatchObject({
        currency: 'USD',
        pricesVersion: '2026-09-25.1',
        licensedDiscount: 0.2,
        storeUrl: `${cloud.url}/store`,
        backup: { includedTb: 1, blockTb: 1, usdPerTbMonth: 9.99 },
        credit: { minimumUsd: 20, maximumUsd: 500 },
      });
      expect(products.products.map(({ id, priceUsd }) => [id, priceUsd])).toEqual([
        ['cloud-monthly', 9.99],
        ['cloud-annual', 99.9],
        ['supporter-server', 100],
        ['supporter-individual', 25],
        ['credit-25', 25],
        ['credit-50', 50],
        ['credit-100', 100],
      ]);
      expect(products.products[2].storeUrl).toBe(`${cloud.url}/store?product=supporter-server`);
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('serves the plan discount Frameleaf Cloud last published, and no other price moves', async () => {
      metadata.set(SystemMetadataKey.FrameleafPricing, {
        current: { pricesVersion: '2026-10-01.2', licensedDiscountPercent: 25, effectiveFrom: '2026-10-01T00:00:00Z' },
        // not in effect yet, so not served
        pending: { pricesVersion: '2999-01-01.1', licensedDiscountPercent: 40, effectiveFrom: '2999-01-01T00:00:00Z' },
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const products = await sut.getProducts();
      expect(products).toMatchObject({
        pricesVersion: '2026-10-01.2',
        licensedDiscount: 0.25,
        backup: { includedTb: 1, blockTb: 1, usdPerTbMonth: 9.99 },
      });
      expect(products.products.find(({ id }) => id === 'cloud-monthly')?.priceUsd).toBe(9.99);
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('uses the store discovery names, as the link recorded it, still without an outbound call (FL-177)', async () => {
      metadata.set(SystemMetadataKey.FrameleafCloudLink, {
        status: 'linked',
        cloudUrl,
        instanceId: instanceId(),
        store: `${cloud.url}/account/store/`,
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const products = await sut.getProducts();
      expect(products.storeUrl).toBe(`${cloud.url}/account/store`);
      expect(products.products[0].storeUrl).toBe(`${cloud.url}/account/store?product=cloud-monthly`);
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('uses the store of discovery this process already holds', async () => {
      const original = cloud.discovery;
      cloud.discovery = () => ({ ...original(), store: `${cloud.url}/shop` });
      await (
        sut as unknown as { frameleafCloudRepository: FrameleafCloudRepository }
      ).frameleafCloudRepository.discovery(cloud.url);
      await expect(sut.getProducts()).resolves.toMatchObject({ storeUrl: `${cloud.url}/shop` });
    });

    it('never links to a store outside the configured cloud; it falls back to FRAMELEAF_CLOUD_URL/store', async () => {
      metadata.set(SystemMetadataKey.FrameleafCloudLink, {
        status: 'linked',
        cloudUrl,
        instanceId: instanceId(),
        store: 'https://store.elsewhere.test/store',
      });
      await expect(sut.getProducts()).resolves.toMatchObject({ storeUrl: `${cloud.url}/store` });
    });

    it('has no store link when Frameleaf Cloud is not set up', async () => {
      cloudUrl = null;
      const products = await sut.getProducts();
      expect(products.storeUrl).toBeNull();
      expect(products.products.every(({ storeUrl }) => storeUrl === null)).toBe(true);
    });
  });

  describe('link codes (CLD-004, golden fixtures of frameleaf-cloud PR #82)', () => {
    const golden = {
      request: cloudContractFixture('licence/redeem-link-code-request.json'),
      personal: cloudContractFixture('licence/redeem-link-code-request-personal.json'),
      response: cloudContractFixture('licence/redeem-link-code-response.json'),
      discovery: cloudContractFixture('instance/discovery.json'),
    };
    const CODE: string = golden.request.code;
    const REDEEM = '/api/v1/licenses/redeem-link-code';
    /** The published discovery document's switch and redeem address, pointed at the fake cloud. */
    const enable = (endpoint = `${cloud.url}${REDEEM}`) => {
      const base = cloud.discovery;
      expect(golden.discovery.features).toEqual({ licenseLinkCode: true });
      expect(golden.discovery.endpoints.licenseLinkCode).toBe(
        'https://api.frameleaf.cloud/v1/licenses/redeem-link-code',
      );
      cloud.discovery = () => ({
        ...base(),
        features: golden.discovery.features,
        endpoints: { licenseLinkCode: endpoint },
      });
    };
    /** The golden answer, with a certificate this spec can sign for this server. */
    const answer = (kind: 'server' | 'individual', last4: string) => ({
      ...golden.response,
      kind,
      last4,
      certificate: certificate({
        ent: [kind === 'server' ? 'SUPPORTER_SERVER' : 'SUPPORTER_INDIVIDUAL'],
        lic_exp: null,
        lic: { id: `lic-${kind}`, kind, last4 },
      }),
    });
    const redeems = () => cloud.requests.filter(({ path }) => path === REDEEM);
    /** A request body has exactly the golden request's shape (the cloud's schema is strict). */
    const expectShape = (body: Record<string, any>, fixture: Record<string, any>) => {
      expect(Object.keys(body).sort()).toEqual(Object.keys(fixture).sort());
      expect(Object.keys(body.fingerprint).sort()).toEqual(Object.keys(fixture.fingerprint).sort());
      expect(body.code).toMatch(/^flc_[a-z2-7]{26}$/);
    };

    it('asks to link first, or paste the key, on an unlinked server and contacts nothing', async () => {
      enable();
      await expect(sut.redeemLinkCode(authStub.admin, { code: CODE })).rejects.toThrow(LINK_CODE_UNAVAILABLE_MESSAGE);
      expect(redeems()).toHaveLength(0);
    });

    it('stays off until discovery advertises features.licenseLinkCode', async () => {
      link();
      serveToken();
      await expect(sut.redeemLinkCode(authStub.admin, { code: CODE })).rejects.toThrow(LINK_CODE_UNAVAILABLE_MESSAGE);
      expect(redeems()).toHaveLength(0);
    });

    it.each([
      'flc_JF23QNBC4WVMPNUOGENCLB2HYO',
      'flc_jf23qnbc4wvmpnuogenclb2hy',
      'flc_jf23qnbc4wvmpnuogenclb2hy1',
      'FL-S8NL-49G8-J583',
    ])('never sends %s, which is not a link code, and asks for the key instead', async (code) => {
      link();
      serveToken();
      enable();
      await expect(sut.redeemLinkCode(authStub.admin, { code })).rejects.toThrow(LINK_CODE_INVALID_MESSAGE);
      expect(cloud.requests).toHaveLength(0);
    });

    it('redeems a server key with the DPoP-bound token, in the golden request shape, never holding the key', async () => {
      link();
      serveToken();
      enable();
      cloud.on(`POST ${REDEEM}`, () => ({ status: 200, body: answer('server', golden.response.last4) }));

      await expect(sut.redeemLinkCode(authStub.admin, { code: CODE })).resolves.toEqual({
        kind: 'server',
        keyHint: golden.response.last4,
      });

      const [request] = redeems();
      expect(redeems()).toHaveLength(1);
      expect(tokenNameOf(request)).toBe('api-token');
      expect(request.dpop).toMatchObject({ claims: { htm: 'POST', htu: `${cloud.url}${REDEEM}` } });
      const identity = metadata.get(SystemMetadataKey.FrameleafInstance) as { kid: string };
      const body = request.json() as Record<string, any>;
      expectShape(body, golden.request);
      // a server key is bound to the server: fingerprint.user would be refused (422)
      expect(body).toEqual({
        code: CODE,
        fingerprint: { instanceId: instanceId(), jkt: identity.kid },
        instanceName: expect.any(String),
        allowKinds: ['server'],
      });
      for (const { path } of cloud.requests) {
        expect(path).not.toContain(CODE);
      }
      expect(store()?.key).toMatchObject({
        kind: 'server',
        keyHint: golden.response.last4,
        activationId: golden.response.activationId,
        source: 'key',
      });
      expect(JSON.stringify(store())).not.toContain(CODE);
      expect(mocks.adminAudit.create).toHaveBeenCalledWith([
        expect.objectContaining({ action: AdminAuditAction.LicenseActivated, detail: golden.response.last4 }),
      ]);
    });

    it('uses endpoints.licenseLinkCode when discovery names one', async () => {
      link();
      serveToken();
      enable(`${cloud.url}/api/v2/redeem`);
      cloud.on('POST /api/v2/redeem', () => ({ status: 200, body: answer('server', 'H23J') }));
      await expect(sut.redeemLinkCode(authStub.admin, { code: CODE })).resolves.toMatchObject({ kind: 'server' });
    });

    it('asks again for this person when an administrator redeems a personal key', async () => {
      link();
      serveToken();
      enable();
      const mismatch = cloudContractFixture('errors/link-code-kind-mismatch.json');
      expect(mismatch.data).toEqual({ kind: 'individual' });
      cloud.on(`POST ${REDEEM}`, (request) =>
        (request.json() as { allowKinds: string[] }).allowKinds.includes('server')
          ? { status: 409, body: mismatch }
          : { status: 200, body: answer('individual', '8EL6') },
      );
      mocks.frameleafUserLicense.getByKeyHash.mockResolvedValue(undefined);
      mocks.frameleafUserLicense.upsert.mockImplementation((row) =>
        Promise.resolve({ ...row, kind: 'individual', activatedAt: new Date('2026-09-25T12:00:00.000Z') }),
      );

      await expect(sut.redeemLinkCode(authStub.admin, { code: CODE })).resolves.toEqual({
        kind: 'individual',
        keyHint: '8EL6',
      });
      const [first, second] = redeems().map((request) => request.json() as Record<string, any>);
      expect(first.allowKinds).toEqual(['server']);
      expectShape(second, golden.personal);
      expect(second.allowKinds).toEqual(golden.personal.allowKinds);
      expect(store()?.key ?? null).toBeNull();
    });

    it('lets anyone else redeem only a personal key, in the golden personal request shape', async () => {
      link();
      serveToken();
      enable();
      cloud.on(`POST ${REDEEM}`, () => ({ status: 200, body: answer('individual', '8EL6') }));
      mocks.frameleafUserLicense.getByKeyHash.mockResolvedValue(undefined);
      mocks.frameleafUserLicense.upsert.mockImplementation((row) =>
        Promise.resolve({ ...row, kind: 'individual', activatedAt: new Date('2026-09-25T12:00:00.000Z') }),
      );

      await expect(sut.redeemLinkCode(authStub.user1, { code: CODE })).resolves.toEqual({
        kind: 'individual',
        keyHint: '8EL6',
      });
      expect(redeems()).toHaveLength(1);
      const body = redeems()[0].json() as Record<string, any>;
      expectShape(body, golden.personal);
      expect(body.allowKinds).toEqual(['individual']);
      expect(body.fingerprint.user).toMatch(/^[\da-f]{64}$/);
      expect(mocks.frameleafUserLicense.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: authStub.user1.user.id,
          keyHint: '8EL6',
          binding: body.fingerprint.user,
          activationId: golden.response.activationId,
        }),
      );
      expect(JSON.stringify(mocks.frameleafUserLicense.upsert.mock.calls)).not.toContain(CODE);
      expect(store()?.key ?? null).toBeNull();
    });

    it('explains a server key to someone who may only hold a personal one', async () => {
      link();
      serveToken();
      enable();
      cloud.on(`POST ${REDEEM}`, () => ({
        status: 409,
        body: {
          ...cloudContractFixture<Record<string, unknown>>('errors/link-code-kind-mismatch.json'),
          data: { kind: 'server' },
        },
      }));
      await expect(sut.redeemLinkCode(authStub.user1, { code: CODE })).rejects.toThrow('This is a server key');
      expect(redeems()).toHaveLength(1);
    });

    it.each([
      [404, 'errors/link-code-not-found.json'],
      [410, 'errors/link-code-expired.json'],
      [410, 'errors/link-code-used.json'],
      [403, 'errors/link-code-wrong-account.json'],
      [409, 'errors/link-code-activation-limit.json'],
      [429, 'errors/link-code-rate-limited.json'],
      [422, 'errors/request-invalid.json'],
    ])('shows the cloud’s own words for a %s %s and asks for the key, never echoing the code', async (status, name) => {
      link();
      serveToken();
      enable();
      const envelope = cloudContractFixture(name);
      cloud.on(`POST ${REDEEM}`, () => ({ status, body: envelope }));
      const error = (await sut
        .redeemLinkCode(authStub.admin, { code: CODE })
        .catch((error_: Error) => error_)) as Error;
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).toBe(`${envelope.message} ${LINK_CODE_PASTE_KEY}`);
      expect(error.message).not.toContain(CODE);
      expect(store()?.key ?? null).toBeNull();
    });

    it('shows a licence on hold during a payment dispute (403 forbidden, as /activate) and asks for the key', async () => {
      link();
      serveToken();
      enable();
      cloud.on(`POST ${REDEEM}`, () => ({
        status: 403,
        body: {
          code: 'forbidden',
          message: 'This licence is on hold while a payment dispute is open.',
          retryable: false,
        },
      }));
      await expect(sut.redeemLinkCode(authStub.admin, { code: CODE })).rejects.toThrow(
        `This licence is on hold while a payment dispute is open. ${LINK_CODE_PASTE_KEY}`,
      );
    });

    it('never echoes a code the cloud puts in its message', async () => {
      link();
      serveToken();
      enable();
      cloud.on(`POST ${REDEEM}`, () => ({
        status: 404,
        body: { code: 'link_code_not_found', message: `No ${CODE}.` },
      }));
      const error = (await sut
        .redeemLinkCode(authStub.admin, { code: CODE })
        .catch((error_: Error) => error_)) as Error;
      expect(error.message).not.toContain(CODE);
    });

    it('explains an instance-id-taken refusal the way activation does', async () => {
      link();
      serveToken();
      enable();
      cloud.on(`POST ${REDEEM}`, () => ({
        status: 409,
        body: cloudContractFixture('errors/link-code-instance-id-taken.json'),
      }));
      await expect(sut.redeemLinkCode(authStub.admin, { code: CODE })).rejects.toThrow(IDENTITY_KEY_MISMATCH_MESSAGE);
    });

    it('treats a 401 as a link that no longer works', async () => {
      link();
      serveToken();
      enable();
      cloud.on(`POST ${REDEEM}`, () => ({ status: 401, body: { code: 'instance_revoked', message: 'revoked' } }));
      await expect(sut.redeemLinkCode(authStub.admin, { code: CODE })).rejects.toThrow(LINK_CODE_UNAVAILABLE_MESSAGE);
      expect(store()?.key ?? null).toBeNull();
    });
  });

  describe('personal supporter keys', () => {
    it('activates an individual key bound to this server and person, and mirrors the summary', async () => {
      cloud.on('POST /api/v1/licenses/activate', () => ({
        status: 200,
        body: {
          certificate: certificate({
            ent: ['SUPPORTER_INDIVIDUAL'],
            lic_exp: null,
            lic: { kind: 'individual', last4: '8EL6' },
          }),
          activationId: 'act-9',
        },
      }));
      mocks.frameleafUserLicense.getByKeyHash.mockResolvedValue(undefined);
      mocks.frameleafUserLicense.upsert.mockImplementation((row) =>
        Promise.resolve({ ...row, kind: 'individual', activatedAt: new Date('2026-09-25T12:00:00.000Z') }),
      );

      await expect(sut.activateUserSupporter(authStub.user1, { key: PERSONAL_KEY })).resolves.toEqual({
        kind: 'individual',
        keyHint: '8EL6',
        activatedAt: new Date('2026-09-25T12:00:00.000Z'),
      });
      const body = await signedActivation(cloud.requests.find(({ path }) => path === '/api/v1/licenses/activate')!);
      expect(body.fingerprint.user).toMatch(/^[\da-f]{64}$/);
      expect(mocks.frameleafUserLicense.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ userId: authStub.user1.user.id, keyHint: '8EL6', binding: body.fingerprint.user }),
      );
      expect(JSON.stringify(mocks.frameleafUserLicense.upsert.mock.calls)).not.toContain(PERSONAL_KEY);
      expect(mocks.user.upsertMetadata).toHaveBeenCalledWith(authStub.user1.user.id, {
        key: UserMetadataKey.License,
        value: { kind: 'individual', keyHint: '8EL6', activatedAt: '2026-09-25T12:00:00.000Z' },
      });
    });

    it('refuses a server key, and a key already active for someone else', async () => {
      await expect(sut.activateUserSupporter(authStub.user1, { key: SERVER_KEY })).rejects.toThrow('server key');
      mocks.frameleafUserLicense.getByKeyHash.mockResolvedValue({ userId: 'someone-else' } as never);
      await expect(sut.activateUserSupporter(authStub.user1, { key: PERSONAL_KEY })).rejects.toThrow(
        'already active for another account',
      );
    });

    it('removes the person’s key and its summary', async () => {
      mocks.frameleafUserLicense.get.mockResolvedValue({ activationId: 'act-9', binding: 'b' } as never);
      cloud.on('POST /api/v1/licenses/deactivate', () => ({ status: 200, body: {} }));
      await sut.removeUserSupporter(authStub.user1);
      expect(mocks.frameleafUserLicense.delete).toHaveBeenCalledWith(authStub.user1.user.id);
      expect(mocks.user.deleteMetadata).toHaveBeenCalledWith(authStub.user1.user.id, UserMetadataKey.License);
    });
  });
});
