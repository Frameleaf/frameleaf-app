import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrameleafLicenseStore } from 'src/types.js';
import { AdminAuditAction, JobStatus, NotificationLevel, SystemMetadataKey, UserMetadataKey } from 'src/enum.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { FrameleafLicenseService } from 'src/services/frameleaf-license.service.js';
import { FakeCloud, startFakeCloud, tokenAnswer, tokenNameOf } from 'test/fake-frameleaf-cloud.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { makeLicenseSigner, signLicenseCertificate } from 'test/fixtures/frameleaf-license.fixture.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const SERVER_KEY = 'FL-S8NL-49G8-J58U';
const PERSONAL_KEY = 'FL-IC8Q-BT2Q-8ELH';

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
            lic: { id: 'lic-1', last4: 'J58U', kind: 'server' },
          }),
          activationId: 'act-1',
        },
      }));

      const status = await sut.activate(authStub.admin, { key: SERVER_KEY });

      const request = cloud.requests.find(({ path }) => path === '/api/v1/licenses/activate')!;
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers.dpop).toBeUndefined();
      expect(request.json()).toMatchObject({
        key: SERVER_KEY,
        fingerprint: { instanceId: instanceId(), jkt: expect.any(String) },
        instanceName: expect.any(String),
      });
      expect(status).toMatchObject({
        state: 'active',
        kind: 'server',
        keyHint: 'J58U',
        licensed: true,
        entitlements: { supporter: true, remoteAccess: false },
        key: { kind: 'server', source: 'key', keyHint: 'J58U', expiresAt: null },
      });
      expect(JSON.stringify(store())).not.toContain(SERVER_KEY);
      expect(mocks.adminAudit.create).toHaveBeenCalledWith([
        expect.objectContaining({ action: AdminAuditAction.LicenseActivated, detail: 'J58U' }),
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
      expect(cloud.requests.find(({ path }) => path === '/api/v1/licenses/deactivate')?.json()).toMatchObject({
        activationId: 'act-1',
        licenseId: 'lic-1',
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
            lic: { kind: 'individual', last4: '8ELH' },
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
        keyHint: '8ELH',
        activatedAt: new Date('2026-09-25T12:00:00.000Z'),
      });
      const body = cloud.requests.find(({ path }) => path === '/api/v1/licenses/activate')!.json();
      expect(body.fingerprint.user).toMatch(/^[\da-f]{64}$/);
      expect(mocks.frameleafUserLicense.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ userId: authStub.user1.user.id, keyHint: '8ELH', binding: body.fingerprint.user }),
      );
      expect(JSON.stringify(mocks.frameleafUserLicense.upsert.mock.calls)).not.toContain(PERSONAL_KEY);
      expect(mocks.user.upsertMetadata).toHaveBeenCalledWith(authStub.user1.user.id, {
        key: UserMetadataKey.License,
        value: { kind: 'individual', keyHint: '8ELH', activatedAt: '2026-09-25T12:00:00.000Z' },
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
