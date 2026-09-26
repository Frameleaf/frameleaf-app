import { ConflictException } from '@nestjs/common';
import { decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrameleafLicenseStore } from 'src/types.js';
import { AdminAuditAction, JobStatus, NotificationLevel, SystemMetadataKey, UserMetadataKey } from 'src/enum.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { FrameleafLicenseService, IDENTITY_KEY_MISMATCH_MESSAGE } from 'src/services/frameleaf-license.service.js';
import { ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';
import { FakeCloud, FakeCloudRequest, startFakeCloud, tokenAnswer, tokenNameOf } from 'test/fake-frameleaf-cloud.js';
import { authStub } from 'test/fixtures/auth.stub.js';
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
      await sut.installCertificate(authStub.admin, {
        certificate: certificate({ lic_exp: now() + 2, exp: now() + 2, grace_days: 7 }),
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
        expect.objectContaining({ level: NotificationLevel.Warning, dedupeKey: expect.stringContaining('grace') }),
      );
      mocks.event.emit.mockClear();
      await sut.handleRefresh({ force: true });
      expect(mocks.event.emit).not.toHaveBeenCalled();
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
