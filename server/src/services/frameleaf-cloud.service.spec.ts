import { AsyncLocalStorage } from 'node:async_hooks';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrameleafCloudLink, FrameleafInstanceIdentity } from 'src/types.js';
import { AdminAuditAction, DatabaseLock, JobName, JobStatus, NotificationLevel, SystemMetadataKey } from 'src/enum.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import {
  CANDIDATE_KEY_FILE,
  InstanceIdentityRepository,
  PROVEN_KEY_FILE,
  RETIRING_KEY_FILE,
  RETIRING_META_FILE,
  ROTATION_NEEDED_FILE,
  SET_ASIDE_MARK,
} from 'src/repositories/instance-identity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { FrameleafCloudService } from 'src/services/frameleaf-cloud.service.js';
import { clearConfigCache } from 'src/utils/config.js';
import { HEARTBEAT_FIELDS } from 'src/utils/frameleaf-cloud-link.js';
import { FakeCloud, FakeCloudAnswer, startFakeCloud } from 'test/fake-frameleaf-cloud.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const admin = { id: authStub.admin.user.id, name: 'Admin', isAdmin: true };

describe(FrameleafCloudService.name, () => {
  let sut: FrameleafCloudService;
  let mocks: ServiceMocks;
  let cloud: FakeCloud;
  let identityDir: string;
  let metadata: Map<string, unknown>;
  let cloudUrl: string | null;
  let linkToken: string | null;
  let identityRepository: InstanceIdentityRepository;
  /** Whether each identity load ran under `DatabaseLock.FrameleafIdentity`. */
  let identityCalls: { method: string; locked: boolean }[];
  // like the real lock (an in-process AsyncLock plus a Postgres advisory lock), not re-entrant: taking
  // a lock already held from inside it would wait forever, so the fake fails the test instead (FL-175)
  const heldLocks = new AsyncLocalStorage<DatabaseLock[]>();

  const storedLink = () => metadata.get(SystemMetadataKey.FrameleafCloudLink) as FrameleafCloudLink | undefined;
  const cloudMlEnabled = () =>
    !!(metadata.get(SystemMetadataKey.SystemConfig) as { frameleafCloud?: { cloudMl?: { enabled?: boolean } } })
      ?.frameleafCloud?.cloudMl?.enabled;
  /** The decoded JWS header of a compact JWS. */
  const headerOf = (jws: string) =>
    JSON.parse(Buffer.from(jws.split('.', 1)[0], 'base64url').toString('utf8')) as { kid: string };
  const pathsCalled = () => cloud.requests.map(({ method, path }) => `${method} ${path}`);

  /** The fake cloud's link and token endpoints. `grant` answers the device-code poll. */
  const serveLinking = (grant: () => { status: number; body: unknown }) => {
    cloud.on('POST /id/device/auth', () => ({
      status: 200,
      body: {
        device_code: 'device-code-1',
        user_code: 'BCDF-GHJK',
        verification_uri: `${cloud.url}/link`,
        verification_uri_complete: `${cloud.url}/link?code=BCDF-GHJK`,
        expires_in: 600,
        interval: 5,
      },
    }));
    cloud.on('POST /id/token', (request) =>
      request.form().get('grant_type') === 'client_credentials'
        ? { status: 200, body: { access_token: 'api-token', expires_in: 600 } }
        : grant(),
    );
    cloud.on('POST /api/v1/instances', () => ({
      status: 200,
      body: {
        instanceId: 'instance-1',
        oidc: {
          issuer: `${cloud.url}/id`,
          clientId: 'instance-1',
          initialAccessToken: 'initial-access-token',
          registrationEndpoint: `${cloud.url}/id/reg`,
          scope: 'openid email profile',
          roleClaim: 'frameleaf_role',
          storageLabelClaim: '',
        },
        services: { relayOrigin: 'https://r.label.frameleaf-direct.test' },
        owner: { accountId: 'account-1', email: 'owner@example.test', dataRegion: 'eu' },
      },
    }));
    cloud.on('POST /id/reg', () => ({ status: 201, body: { client_id: 'instance-1' } }));
  };

  const makeDue = () => {
    const link = storedLink()!;
    metadata.set(SystemMetadataKey.FrameleafCloudLink, {
      ...link,
      ...(link.pending && { pending: { ...link.pending, nextPollAt: new Date(0).toISOString() } }),
      ...(link.heartbeat && { heartbeat: { ...link.heartbeat, nextAt: new Date(0).toISOString() } }),
    });
  };

  const linkNow = async () => {
    serveLinking(() => ({ status: 200, body: { access_token: 'link-token', expires_in: 600 } }));
    await sut.startLink(authStub.admin);
    makeDue();
    await sut.getLink();
    expect(storedLink()?.status).toBe('linked');
    cloud.requests.length = 0;
  };

  beforeEach(async () => {
    cloud = await startFakeCloud();
    identityDir = await mkdtemp(join(tmpdir(), 'frameleaf-identity-'));
    cloudUrl = cloud.url;
    linkToken = null;
    metadata = new Map();
    clearConfigCache();
    identityRepository = new InstanceIdentityRepository();
    identityCalls = [];
    // every call that reads or changes the key files must hold the identity lock (FL-175)
    const target = identityRepository as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    for (const method of [
      'loadOrCreate',
      'rotate',
      'promoteCandidate',
      'discardCandidate',
      'candidateSigner',
      'removeRetired',
      'clearRotationNeeded',
    ]) {
      const original = target[method].bind(identityRepository);
      vi.spyOn(target, method).mockImplementation((...args) => {
        const locked = !!heldLocks.getStore()?.includes(DatabaseLock.FrameleafIdentity);
        identityCalls.push({ method, locked });
        return locked
          ? original(...args)
          : Promise.reject(new Error(`${method} ran outside DatabaseLock.FrameleafIdentity`));
      });
    }
    ({ sut, mocks } = newTestService(FrameleafCloudService, {
      frameleafCloud: new FrameleafCloudRepository(LoggingRepository.create()),
      instanceIdentity: identityRepository,
    }));
    const baseEnv = mocks.config.getEnv();
    mocks.config.getEnv.mockImplementation(
      () =>
        ({
          ...baseEnv,
          frameleafCloud: {
            url: cloudUrl,
            identityDir,
            linkToken,
            edge: { port: 2443, bind: '0.0.0.0', secret: null },
            localUrl: null,
            trustedLanCidrs: [],
          },
        }) as never,
    );
    mocks.systemMetadata.get.mockImplementation((key) => Promise.resolve((metadata.get(key) ?? null) as never));
    mocks.systemMetadata.set.mockImplementation((key, value) => {
      metadata.set(key, value);
      return Promise.resolve();
    });
    mocks.systemMetadata.delete.mockImplementation((key) => {
      metadata.delete(key);
      return Promise.resolve();
    });
    mocks.forkSchema.persistConfig.mockImplementation((partial) => {
      metadata.set(SystemMetadataKey.SystemConfig, partial);
      return Promise.resolve();
    });
    mocks.database.withLock.mockImplementation((lock, callback) => {
      const held = heldLocks.getStore() ?? [];
      if (held.includes(lock)) {
        return Promise.reject(new Error(`withLock(${DatabaseLock[lock]}) taken again inside itself would deadlock`));
      }
      return heldLocks.run([...held, lock], callback) as never;
    });
    mocks.user.getAdmins.mockResolvedValue([admin] as never);
    mocks.event.emit.mockResolvedValue(undefined as never);
    mocks.storage.stat.mockResolvedValue({} as never);
    mocks.cron.create.mockReturnValue(undefined as never);
  });

  afterEach(async () => {
    await cloud.close();
    await rm(identityDir, { recursive: true, force: true });
  });

  describe('status (FL-154)', () => {
    it('reports not-configured and contacts nothing when FRAMELEAF_CLOUD_URL is unset', async () => {
      cloudUrl = null;
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      await expect(sut.getStatus()).resolves.toMatchObject({
        state: 'not-configured',
        configured: false,
        cloudHost: null,
      });
      await expect(sut.startLink(authStub.admin)).rejects.toThrow('not configured');
      await expect(sut.handleHeartbeat()).resolves.toBe(JobStatus.Skipped);
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('reports unlinked when configured and never contacts the cloud without a link', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      await expect(sut.getStatus()).resolves.toMatchObject({
        state: 'unlinked',
        configured: true,
        heartbeatFields: [...HEARTBEAT_FIELDS],
        permissions: { allowRemoteEnable: false, allowBackupTrigger: true, allowEntitlementRefresh: true },
      });
      await expect(sut.getLink()).resolves.toMatchObject({ state: 'unlinked' });
      await expect(sut.handleHeartbeat()).resolves.toBe(JobStatus.Skipped);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(cloud.requests).toHaveLength(0);
      fetchSpy.mockRestore();
    });

    it('ignores a link made against another Frameleaf Cloud address', async () => {
      metadata.set(SystemMetadataKey.FrameleafCloudLink, { status: 'linked', cloudUrl: 'https://other.test' });
      await expect(sut.getStatus()).resolves.toMatchObject({ state: 'unlinked', account: null });
    });
  });

  describe('device flow (FL-155)', () => {
    it('starts a device authorization with this server’s name, version, key thumbprint and platform', async () => {
      serveLinking(() => ({ status: 400, body: { error: 'authorization_pending' } }));
      const status = await sut.startLink(authStub.admin);

      expect(status).toMatchObject({
        state: 'pending',
        linkResult: 'pending',
        pending: {
          userCode: 'BCDF-GHJK',
          verificationUriComplete: `${cloud.url}/link?code=BCDF-GHJK`,
          intervalSeconds: 5,
        },
      });
      expect(JSON.stringify(status)).not.toContain('device-code-1');
      const form = cloud.requests.find(({ path }) => path === '/id/device/auth')!.form();
      expect(form.get('client_id')).toBe('frameleaf-link');
      expect(form.get('jkt')).toBe(status.keyFingerprint);
      expect(form.get('instance_name')).toBeTruthy();
      expect(form.get('version')).toBeTruthy();
      expect(form.get('platform')).toMatch(/\//);
    });

    it('does not poll before the interval, and keeps waiting on authorization_pending', async () => {
      serveLinking(() => ({ status: 400, body: { error: 'authorization_pending' } }));
      await sut.startLink(authStub.admin);
      cloud.requests.length = 0;

      await sut.getLink();
      expect(pathsCalled()).toEqual([]);

      makeDue();
      await expect(sut.getLink()).resolves.toMatchObject({ state: 'pending', linkResult: 'pending' });
      expect(pathsCalled()).toEqual(['POST /id/token']);
      expect(cloud.requests[0].form().get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
      expect(Date.parse(storedLink()!.pending!.nextPollAt)).toBeGreaterThan(Date.now());
    });

    it('adds five seconds to the interval on slow_down', async () => {
      serveLinking(() => ({ status: 400, body: { error: 'slow_down' } }));
      await sut.startLink(authStub.admin);
      makeDue();
      await expect(sut.getLink()).resolves.toMatchObject({ pending: { intervalSeconds: 10 } });
    });

    it.each([
      ['expired_token', 'expired'],
      ['access_denied', 'denied'],
    ])('ends the attempt on %s', async (error, result) => {
      serveLinking(() => ({ status: 400, body: { error } }));
      await sut.startLink(authStub.admin);
      makeDue();
      await expect(sut.getLink()).resolves.toMatchObject({ state: 'unlinked', linkResult: result, pending: null });
      expect(storedLink()?.pending).toBeUndefined();
    });

    it('ends a code that passed its expiry without asking the cloud', async () => {
      serveLinking(() => ({ status: 400, body: { error: 'authorization_pending' } }));
      await sut.startLink(authStub.admin);
      const link = storedLink()!;
      metadata.set(SystemMetadataKey.FrameleafCloudLink, {
        ...link,
        pending: { ...link.pending!, expiresAt: new Date(0).toISOString() },
      });
      cloud.requests.length = 0;
      await expect(sut.getLink()).resolves.toMatchObject({ state: 'unlinked', linkResult: 'expired' });
      expect(cloud.requests).toHaveLength(0);
    });

    it('registers on approval, completes client registration once and keeps no secret', async () => {
      await linkNow();
      const link = storedLink()!;

      expect(link).toMatchObject({
        status: 'linked',
        instanceId: 'instance-1',
        accountId: 'account-1',
        accountLabel: 'owner@example.test',
        dataRegion: 'eu',
        lastLinkResult: 'approved',
        oidc: { clientId: 'instance-1', roleClaim: 'frameleaf_role', storageLabelClaim: '' },
        desired: { remoteAccess: false, cloudBackup: false },
      });
      const stored = JSON.stringify(link);
      expect(stored).not.toContain('initial-access-token');
      expect(stored).not.toContain('link-token');
      expect(stored).not.toContain('device-code-1');
      expect(mocks.adminAudit.create).toHaveBeenCalledWith([
        expect.objectContaining({ action: AdminAuditAction.CloudLinked, actorId: authStub.admin.user.id }),
      ]);
      expect(mocks.event.emit).toHaveBeenCalledWith(
        'AdminNotify',
        expect.objectContaining({ title: 'Server linked to Frameleaf' }),
      );
      await expect(sut.getStatus()).resolves.toMatchObject({
        state: 'linked',
        account: { id: 'account-1', label: 'owner@example.test' },
        signInClientId: 'instance-1',
      });
    });

    it('refuses a link response whose sign-in issuer is not on the configured cloud', async () => {
      serveLinking(() => ({ status: 200, body: { access_token: 'link-token', expires_in: 600 } }));
      const original = cloud.routes.get('POST /api/v1/instances')!;
      cloud.on('POST /api/v1/instances', async (request) => {
        const answer = await original(request);
        const body = answer.body as { oidc: Record<string, unknown> };
        return { ...answer, body: { ...body, oidc: { ...body.oidc, issuer: 'https://id.elsewhere.test' } } };
      });
      await sut.startLink(authStub.admin);
      makeDue();
      await sut.getLink();
      expect(storedLink()?.status).not.toBe('linked');
      expect(pathsCalled()).not.toContain('POST /id/reg');
    });

    it('sends the link token to POST /v1/instances and the initial access token to /reg', async () => {
      serveLinking(() => ({ status: 200, body: { access_token: 'link-token', expires_in: 600 } }));
      await sut.startLink(authStub.admin);
      makeDue();
      await sut.getLink();

      const register = cloud.requests.find(({ path }) => path === '/api/v1/instances')!;
      expect(register.headers.authorization).toBe('Bearer link-token');
      expect(register.json()).toMatchObject({
        name: expect.any(String),
        version: expect.any(String),
        platform: expect.any(String),
        jwk: { kty: 'OKP', crv: 'Ed25519', kid: expect.any(String) },
        bootId: expect.any(String),
        capabilities: expect.any(Array),
        permissions: { allowRemoteEnable: false, allowBackupTrigger: true, allowEntitlementRefresh: true },
      });
      const registration = cloud.requests.find(({ path }) => path === '/id/reg')!;
      expect(registration.headers.authorization).toBe('Bearer initial-access-token');
      expect(registration.json()).toMatchObject({
        token_endpoint_auth_method: 'private_key_jwt',
        redirect_uris: [
          'https://r.label.frameleaf-direct.test/auth/login',
          'https://r.label.frameleaf-direct.test/user-settings',
          'https://r.label.frameleaf-direct.test/link',
          'https://r.label.frameleaf-direct.test/api/oauth/mobile-redirect',
          'frameleaf-auth:///oauth-callback',
        ],
      });
      expect(cloud.requests.filter(({ path }) => path === '/id/reg')).toHaveLength(1);
    });

    it('cancels a pending code', async () => {
      serveLinking(() => ({ status: 400, body: { error: 'authorization_pending' } }));
      await sut.startLink(authStub.admin);
      await expect(sut.cancelLink()).resolves.toMatchObject({ state: 'unlinked', pending: null });
    });

    it('refuses to start a second link while linked', async () => {
      await linkNow();
      await expect(sut.startLink(authStub.admin)).rejects.toThrow('already linked');
    });
  });

  describe('headless link token (FL-155)', () => {
    it('links once with X-Frameleaf-Link-Token and never sends the same token again', async () => {
      serveLinking(() => ({ status: 400, body: { error: 'authorization_pending' } }));
      linkToken = 'fll_headless_token_1';
      await sut.onBootstrap();

      const register = cloud.requests.find(({ path }) => path === '/api/v1/instances')!;
      expect(register.headers['x-frameleaf-link-token']).toBe('fll_headless_token_1');
      expect(register.headers.authorization).toBeUndefined();
      expect(storedLink()?.status).toBe('linked');
      expect(JSON.stringify(storedLink())).not.toContain('fll_headless_token_1');

      // unlinked later, the same token on a later boot does nothing
      metadata.set(SystemMetadataKey.FrameleafCloudLink, { ...storedLink()!, status: 'unlinked' });
      cloud.requests.length = 0;
      await sut.onBootstrap();
      expect(cloud.requests).toHaveLength(0);
      expect(mocks.logger.log).toHaveBeenCalledWith(expect.stringContaining('already used once'));
    });

    it('records a token the cloud refuses and does not retry it', async () => {
      serveLinking(() => ({ status: 400, body: { error: 'authorization_pending' } }));
      cloud.on('POST /api/v1/instances', () => ({
        status: 401,
        body: { code: 'invalid-link-token', message: 'expired' },
      }));
      linkToken = 'fll_headless_token_2';
      await sut.onBootstrap();
      expect(storedLink()).toMatchObject({ status: 'unlinked', lastError: expect.stringContaining('link token') });
      cloud.requests.length = 0;
      await sut.onBootstrap();
      expect(cloud.requests).toHaveLength(0);
    });
  });

  describe('heartbeat (FL-155)', () => {
    beforeEach(async () => {
      await linkNow();
    });

    it('sends exactly the fields the "What this server sends" panel lists', async () => {
      cloud.on('POST /api/v1/instance/heartbeat', () => ({ status: 200, body: { nextHeartbeatSec: 120 } }));
      makeDue();
      await expect(sut.handleHeartbeat()).resolves.toBe(JobStatus.Success);

      const beat = cloud.requests.find(({ path }) => path === '/api/v1/instance/heartbeat')!;
      expect(beat.headers.authorization).toBe('Bearer api-token');
      expect(Object.keys(beat.json())).toEqual([...HEARTBEAT_FIELDS]);
      expect((await sut.getStatus()).heartbeatFields).toEqual(Object.keys(beat.json()));
      const nextAt = Date.parse(storedLink()!.heartbeat!.nextAt!);
      expect(nextAt - Date.now()).toBeGreaterThan(110_000);
      expect(nextAt - Date.now()).toBeLessThan(151_000);
    });

    it('keeps the plan pricing a check-in publishes, holds a future one, and keeps the last good one through a bad value', async () => {
      // in effect already (newer than the bundled 2026-09-25.1), and one far in the future
      const pricing = {
        pricesVersion: '2026-09-25.2',
        licensedDiscountPercent: 25,
        effectiveFrom: '2026-09-25T00:00:00Z',
      };
      const future = {
        pricesVersion: '2999-01-01.1',
        licensedDiscountPercent: 30,
        effectiveFrom: '2999-01-01T00:00:00Z',
      };
      let body: Record<string, unknown> = { nextHeartbeatSec: 120, pricing };
      cloud.on('POST /api/v1/instance/heartbeat', () => ({ status: 200, body }));
      makeDue();
      await expect(sut.handleHeartbeat()).resolves.toBe(JobStatus.Success);
      expect(metadata.get(SystemMetadataKey.FrameleafPricing)).toEqual({ current: pricing });

      body = { nextHeartbeatSec: 120, pricing: future };
      makeDue();
      await expect(sut.handleHeartbeat()).resolves.toBe(JobStatus.Success);
      expect(metadata.get(SystemMetadataKey.FrameleafPricing)).toEqual({ current: pricing, pending: future });

      body = {
        nextHeartbeatSec: 120,
        pricing: { ...future, pricesVersion: '2999-01-01.2', licensedDiscountPercent: 80 },
      };
      makeDue();
      await expect(sut.handleHeartbeat()).resolves.toBe(JobStatus.Success);
      expect(metadata.get(SystemMetadataKey.FrameleafPricing)).toEqual({ current: pricing, pending: future });
    });

    it('still completes the check-in when the published pricing cannot be stored', async () => {
      const pricing = {
        pricesVersion: '2026-09-25.2',
        licensedDiscountPercent: 25,
        effectiveFrom: '2026-09-25T00:00:00Z',
      };
      cloud.on('POST /api/v1/instance/heartbeat', () => ({ status: 200, body: { nextHeartbeatSec: 120, pricing } }));
      makeDue();
      const set = mocks.systemMetadata.set.getMockImplementation()!;
      mocks.systemMetadata.set.mockImplementation((key, value) =>
        key === SystemMetadataKey.FrameleafPricing ? Promise.reject(new Error('database is down')) : set(key, value),
      );

      await expect(sut.handleHeartbeat()).resolves.toBe(JobStatus.Success);
      expect(metadata.has(SystemMetadataKey.FrameleafPricing)).toBe(false);
      expect(storedLink()!.heartbeat!.failures).toBe(0);
    });

    it('waits for the next check-in time', async () => {
      await expect(sut.handleHeartbeat()).resolves.toBe(JobStatus.Skipped);
      expect(cloud.requests).toHaveLength(0);
    });

    it('runs a command only when its toggle allows it, and acknowledges every command', async () => {
      const acks: Array<{ id: string; body: any }> = [];
      cloud.on('POST /api/v1/instance/heartbeat', () => ({
        status: 200,
        body: {
          commands: [
            { id: 'c1', type: 'remote.enable' },
            { id: 'c2', type: 'relink' },
            { id: 'c3', type: 'erase.everything' },
          ],
        },
      }));
      for (const id of ['c1', 'c2', 'c3']) {
        cloud.on(`POST /api/v1/instance/commands/${id}/ack`, (request) => {
          acks.push({ id, body: request.json() });
          return { status: 200, body: {} };
        });
      }
      makeDue();
      await sut.handleHeartbeat();

      expect(acks).toEqual([
        { id: 'c1', body: { result: 'refused', detail: expect.stringContaining('allowRemoteEnable') } },
        { id: 'c2', body: { result: 'done', detail: null } },
        { id: 'c3', body: { result: 'refused', detail: 'unknown command' } },
      ]);
      expect(storedLink()).toMatchObject({
        desired: { remoteAccess: false },
        heartbeat: { relinkRequested: true },
      });

      await sut.updatePermissions(authStub.admin, { allowRemoteEnable: true });
      expect(mocks.adminAudit.create).toHaveBeenCalledWith([
        expect.objectContaining({ action: AdminAuditAction.CloudPermissionsChanged }),
      ]);
      acks.length = 0;
      makeDue();
      await sut.handleHeartbeat();
      expect(acks[0]).toEqual({ id: 'c1', body: { result: 'done', detail: null } });
      expect(storedLink()?.desired?.remoteAccess).toBe(true);
    });

    it('refreshes the licence when entitlements changed and the toggle allows it', async () => {
      cloud.on('POST /api/v1/instance/heartbeat', () => ({ status: 200, body: { entitlementsChanged: true } }));
      makeDue();
      await sut.handleHeartbeat();
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.FrameleafLicenseRefresh, data: { force: true } });
    });

    it('tells administrators once about repeated failures and clone suspicion', async () => {
      cloud.on('POST /api/v1/instance/heartbeat', () => ({
        status: 503,
        body: { code: 'unavailable', message: 'down' },
      }));
      for (let attempt = 0; attempt < 3; attempt++) {
        makeDue();
        await expect(sut.handleHeartbeat()).resolves.toBe(JobStatus.Failed);
      }
      expect(storedLink()?.heartbeat?.failures).toBe(3);
      expect(mocks.event.emit).toHaveBeenCalledWith(
        'AdminNotify',
        expect.objectContaining({ dedupeKey: 'frameleaf-cloud:heartbeat-failing', level: NotificationLevel.Warning }),
      );

      cloud.on('POST /api/v1/instance/heartbeat', () => ({ status: 200, body: { cloneSuspected: true } }));
      makeDue();
      await sut.handleHeartbeat();
      expect(storedLink()?.heartbeat).toMatchObject({ failures: 0, cloneSuspected: true });
      expect(mocks.event.emit).toHaveBeenCalledWith(
        'AdminNotify',
        expect.objectContaining({ dedupeKey: 'frameleaf-cloud:clone-suspected' }),
      );
    });

    it('treats invalid_client as a cloud-side revoke: no secret left, cloud features off, nothing deleted', async () => {
      metadata.set(SystemMetadataKey.SystemConfig, { frameleafCloud: { cloudMl: { enabled: true } } });
      clearConfigCache();
      cloud.on('POST /id/token', () => ({ status: 401, body: { error: 'invalid_client' } }));
      sutForgetTokens();
      makeDue();
      await expect(sut.handleHeartbeat()).resolves.toBe(JobStatus.Failed);

      expect(storedLink()).toMatchObject({
        status: 'revoked',
        revoked: { reason: expect.any(String) },
        desired: { remoteAccess: false, cloudBackup: false },
      });
      expect(storedLink()?.oidc).toBeUndefined();
      expect(cloudMlEnabled()).toBe(false);
      expect(mocks.adminAudit.create).toHaveBeenCalledWith([
        expect.objectContaining({ action: AdminAuditAction.CloudRevoked }),
      ]);
      await expect(sut.getStatus()).resolves.toMatchObject({
        state: 'revoked',
        revoked: { reason: expect.any(String) },
      });
    });

    it('keeps a key whose rotation answer was lost, and finishes the rotation when the cloud turns out to hold it', async () => {
      const before = metadata.get(SystemMetadataKey.FrameleafInstance) as { kid: string };
      cloud.on('POST /api/v1/instance/heartbeat', () => ({
        status: 200,
        body: { commands: [{ id: 'k1', type: 'key.rotate' }] },
      }));
      cloud.on('GET /api/v1/instance/keys/nonce', () => ({ status: 200, body: { nonce: 'nonce-12345' } }));
      // the cloud stores the new key but the answer never arrives
      let held = '';
      cloud.on('POST /api/v1/instance/keys/rotate', (request) => {
        held = request.json().newJwk.kid;
        return { status: 503, body: { code: 'unavailable', message: 'lost' } };
      });
      cloud.on('POST /api/v1/instance/commands/k1/ack', () => ({ status: 200, body: {} }));
      makeDue();
      await sut.handleHeartbeat();
      expect(held).not.toBe('');
      expect((metadata.get(SystemMetadataKey.FrameleafInstance) as { kid: string }).kid).toBe(before.kid);

      // from now on the cloud only accepts the new key
      cloud.on('POST /id/token', (request) => {
        const header = JSON.parse(
          Buffer.from(request.form().get('client_assertion')!.split('.', 1)[0], 'base64url').toString('utf8'),
        );
        return header.kid === held
          ? { status: 200, body: { access_token: 'api-token', expires_in: 600 } }
          : { status: 401, body: { error: 'invalid_client' } };
      });
      cloud.on('POST /api/v1/instance/heartbeat', () => ({ status: 200, body: {} }));
      sutForgetTokens();
      makeDue();
      await sut.handleHeartbeat();

      expect(storedLink()?.status).toBe('linked');
      const after = metadata.get(SystemMetadataKey.FrameleafInstance) as { kid: string; retiring: { kid: string } };
      expect(after.kid).toBe(held);
      expect(after.retiring.kid).toBe(before.kid);
    });

    it('keeps counting failed check-ins while a candidate key is unresolved', async () => {
      await writeFile(
        join(identityDir, CANDIDATE_KEY_FILE),
        generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }),
        { mode: 0o600 },
      );
      // the current key is refused; the answer for the candidate never comes back
      cloud.on('POST /id/token', (request) => {
        const header = JSON.parse(
          Buffer.from(request.form().get('client_assertion')!.split('.', 1)[0], 'base64url').toString('utf8'),
        );
        const current = (metadata.get(SystemMetadataKey.FrameleafInstance) as { kid: string }).kid;
        return header.kid === current
          ? { status: 401, body: { error: 'invalid_client' } }
          : { status: 503, body: { code: 'unavailable', message: 'no answer' } };
      });
      for (let attempt = 1; attempt <= 3; attempt++) {
        sutForgetTokens();
        makeDue();
        await sut.handleHeartbeat();
      }
      expect(storedLink()?.status).toBe('linked');
      expect(storedLink()?.heartbeat?.failures).toBe(3);
      expect(mocks.event.emit).toHaveBeenCalledWith(
        'AdminNotify',
        expect.objectContaining({ dedupeKey: 'frameleaf-cloud:heartbeat-failing' }),
      );
    });

    it('revokes at once on an explicit instance-revoked, without trying the candidate', async () => {
      await writeFile(
        join(identityDir, CANDIDATE_KEY_FILE),
        generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }),
        { mode: 0o600 },
      );
      let tokenRequests = 0;
      cloud.on('POST /id/token', () => {
        tokenRequests++;
        return { status: 401, body: { error: 'instance-revoked' } };
      });
      sutForgetTokens();
      makeDue();
      await sut.handleHeartbeat();
      expect(storedLink()?.status).toBe('revoked');
      expect(tokenRequests).toBe(1);
    });

    it('revokes when the cloud refuses both the current and the candidate key', async () => {
      await writeFile(
        join(identityDir, CANDIDATE_KEY_FILE),
        generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }),
        { mode: 0o600 },
      );
      cloud.on('POST /id/token', () => ({ status: 401, body: { error: 'invalid_client' } }));
      sutForgetTokens();
      makeDue();
      await sut.handleHeartbeat();
      expect(storedLink()?.status).toBe('revoked');
      await expect(access(join(identityDir, CANDIDATE_KEY_FILE))).rejects.toThrow();
    });

    it('rotates the key when allowed, keeping the old one retiring for 24 hours', async () => {
      const before = metadata.get(SystemMetadataKey.FrameleafInstance) as { kid: string };
      cloud.on('POST /api/v1/instance/heartbeat', () => ({
        status: 200,
        body: { commands: [{ id: 'k1', type: 'key.rotate' }] },
      }));
      cloud.on('GET /api/v1/instance/keys/nonce', () => ({ status: 200, body: { nonce: 'nonce-12345' } }));
      cloud.on('POST /api/v1/instance/keys/rotate', () => ({ status: 200, body: {} }));
      cloud.on('POST /api/v1/instance/commands/k1/ack', () => ({ status: 200, body: {} }));
      makeDue();
      await sut.handleHeartbeat();

      const rotate = cloud.requests.find(({ path }) => path === '/api/v1/instance/keys/rotate')!.json();
      expect(rotate.newJwk.kid).not.toBe(before.kid);
      expect(rotate.proof.split('.')).toHaveLength(3);
      const after = metadata.get(SystemMetadataKey.FrameleafInstance) as {
        kid: string;
        retiring: { kid: string; until: string };
      };
      expect(after.kid).toBe(rotate.newJwk.kid);
      expect(after.retiring.kid).toBe(before.kid);
      expect(Date.parse(after.retiring.until) - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
    });

    it('loads the identity only under the identity lock, without taking it twice (FL-175)', async () => {
      cloud.on('POST /api/v1/instance/heartbeat', () => ({
        status: 200,
        body: { commands: [{ id: 'k1', type: 'key.rotate' }] },
      }));
      cloud.on('GET /api/v1/instance/keys/nonce', () => ({ status: 200, body: { nonce: 'nonce-12345' } }));
      cloud.on('POST /api/v1/instance/keys/rotate', () => ({ status: 200, body: {} }));
      cloud.on('POST /api/v1/instance/commands/k1/ack', () => ({ status: 200, body: {} }));
      identityCalls.length = 0;
      makeDue();
      await expect(sut.handleHeartbeat()).resolves.toBe(JobStatus.Success);
      expect(identityCalls.filter(({ method }) => method === 'loadOrCreate').length).toBeGreaterThan(2);
      expect(identityCalls.map(({ method }) => method)).toContain('rotate');
      expect(identityCalls.every(({ locked }) => locked)).toBe(true);
    });

    it('warns the administrators and rotates again when the key the cloud accepted was damaged (FL-175)', async () => {
      const before = metadata.get(SystemMetadataKey.FrameleafInstance) as FrameleafInstanceIdentity;
      // a crash left the accepted key unreadable before it replaced the current one, 20 hours ago
      await writeFile(join(identityDir, PROVEN_KEY_FILE), 'damaged', { mode: 0o600 });
      const since = Date.now() - 20 * 60 * 60 * 1000;
      const deadline = since + 24 * 60 * 60 * 1000;
      await writeFile(
        join(identityDir, ROTATION_NEEDED_FILE),
        JSON.stringify({ since: new Date(since).toISOString(), until: new Date(deadline).toISOString() }),
      );
      cloud.on('POST /api/v1/instance/heartbeat', () => ({ status: 200, body: {} }));
      cloud.on('GET /api/v1/instance/keys/nonce', () => ({ status: 200, body: { nonce: 'nonce-12345' } }));
      cloud.on('POST /api/v1/instance/keys/rotate', () => ({ status: 200, body: {} }));
      makeDue();
      await expect(sut.handleHeartbeat()).resolves.toBe(JobStatus.Success);

      expect(mocks.event.emit).toHaveBeenCalledWith(
        'AdminNotify',
        expect.objectContaining({ dedupeKey: 'frameleaf-cloud:identity-key-damaged' }),
      );
      const rotate = cloud.requests.find(({ path }) => path === '/api/v1/instance/keys/rotate')!.json();
      const after = metadata.get(SystemMetadataKey.FrameleafInstance) as FrameleafInstanceIdentity;
      expect(after.kid).toBe(rotate.newJwk.kid);
      expect(after.kid).not.toBe(before.kid);
      expect(after.retiring?.kid).toBe(before.kid);
      expect(after.rotationNeeded).toBeUndefined();
      const setAside = (await readdir(identityDir)).filter((name) =>
        name.startsWith(`${PROVEN_KEY_FILE}${SET_ASIDE_MARK}`),
      );
      expect(setAside).toHaveLength(1);
      expect(await readFile(join(identityDir, setAside[0]), 'utf8')).toBe('damaged');

      // the token and the proof both come from the previous (for the cloud, retiring) key
      const tokenKids = cloud.requests
        .filter(({ path }) => path === '/id/token')
        .map((request) => headerOf(request.form().get('client_assertion')!).kid);
      expect(tokenKids.length).toBeGreaterThan(0);
      expect(new Set(tokenKids)).toEqual(new Set([before.kid]));
      const [header, payload, signature] = (rotate.proof as string).split('.', 3);
      expect(headerOf(rotate.proof).kid).toBe(before.kid);
      expect(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))).toEqual({
        nonce: 'nonce-12345',
        jkt: rotate.newJwk.kid,
      });
      expect(
        verify(
          null,
          Buffer.from(`${header}.${payload}`),
          createPublicKey({ key: before.publicJwk, format: 'jwk' }),
          Buffer.from(signature, 'base64url'),
        ),
      ).toBe(true);
      // the previous key keeps its original deadline; recovery never extends it
      expect(Math.abs(Date.parse(after.retiring!.until) - deadline)).toBeLessThanOrEqual(1);
      expect(mocks.adminAudit.create).toHaveBeenCalledWith([
        expect.objectContaining({ action: AdminAuditAction.CloudKeyRecoveryRotation, detail: 'rotated' }),
      ]);

      // done once: the next check-in does not rotate again
      cloud.requests.length = 0;
      makeDue();
      await sut.handleHeartbeat();
      expect(pathsCalled()).not.toContain('POST /api/v1/instance/keys/rotate');
    });

    it('spaces recovery rotations out after a 429, honouring Retry-After (FL-175)', async () => {
      await writeFile(join(identityDir, PROVEN_KEY_FILE), 'damaged', { mode: 0o600 });
      cloud.on('POST /api/v1/instance/heartbeat', () => ({ status: 200, body: {} }));
      cloud.on('GET /api/v1/instance/keys/nonce', () => ({ status: 200, body: { nonce: 'nonce-12345' } }));
      const limited = { code: 'rate-limited', message: 'more than 3 rotations this hour' };
      let answer: FakeCloudAnswer = { status: 429, body: limited };
      cloud.on('POST /api/v1/instance/keys/rotate', () => answer);
      const rotations = () => cloud.requests.filter(({ path }) => path === '/api/v1/instance/keys/rotate').length;
      const nextAttemptIn = () => Date.parse(storedLink()!.heartbeat!.keyRecovery!.nextAttemptAt!) - Date.now();
      const overdue = () => {
        const link = storedLink()!;
        metadata.set(SystemMetadataKey.FrameleafCloudLink, {
          ...link,
          heartbeat: { ...link.heartbeat!, keyRecovery: { nextAttemptAt: new Date(0).toISOString() } },
        });
      };

      makeDue();
      await expect(sut.handleHeartbeat()).resolves.toBe(JobStatus.Success);
      expect(rotations()).toBe(1);
      expect(nextAttemptIn()).toBeGreaterThan(19 * 60 * 1000);
      expect(nextAttemptIn()).toBeLessThanOrEqual(20 * 60 * 1000);
      await expect(access(join(identityDir, ROTATION_NEEDED_FILE))).resolves.toBeUndefined();

      // check-ins inside the gap do not rotate
      makeDue();
      await sut.handleHeartbeat();
      makeDue();
      await sut.handleHeartbeat();
      expect(rotations()).toBe(1);

      // the cloud asks for half an hour
      answer = { status: 429, body: limited, headers: { 'Retry-After': '1800' } };
      overdue();
      makeDue();
      await sut.handleHeartbeat();
      expect(rotations()).toBe(2);
      expect(nextAttemptIn()).toBeGreaterThan(29 * 60 * 1000);
      expect(nextAttemptIn()).toBeLessThanOrEqual(30 * 60 * 1000);
      expect(storedLink()?.heartbeat?.relinkRequested).toBeFalsy();

      answer = { status: 200, body: {} };
      overdue();
      makeDue();
      await sut.handleHeartbeat();
      expect(rotations()).toBe(3);
      expect(storedLink()?.heartbeat?.keyRecovery).toBeUndefined();
      expect((metadata.get(SystemMetadataKey.FrameleafInstance) as FrameleafInstanceIdentity).rotationNeeded).toBe(
        undefined,
      );
      for (const detail of ['retrying', 'rotated']) {
        expect(mocks.adminAudit.create).toHaveBeenCalledWith([
          expect.objectContaining({ action: AdminAuditAction.CloudKeyRecoveryRotation, detail }),
        ]);
      }
    });

    it('asks for the server to be linked again when the cloud refuses the recovery because the window closed (FL-175)', async () => {
      await writeFile(join(identityDir, PROVEN_KEY_FILE), 'damaged', { mode: 0o600 });
      cloud.on('POST /api/v1/instance/heartbeat', () => ({ status: 200, body: {} }));
      cloud.on('GET /api/v1/instance/keys/nonce', () => ({ status: 200, body: { nonce: 'nonce-12345' } }));
      cloud.on('POST /api/v1/instance/keys/rotate', () => ({
        status: 401,
        body: { code: 'key-retired', message: 'the retiring key is past its window' },
      }));
      makeDue();
      await expect(sut.handleHeartbeat()).resolves.toBe(JobStatus.Success);

      expect(storedLink()?.status).toBe('linked');
      expect(storedLink()?.heartbeat).toMatchObject({ relinkRequested: true, keyRecovery: { closed: true } });
      await expect(sut.getStatus()).resolves.toMatchObject({ relinkRequested: true });
      expect(mocks.event.emit).toHaveBeenCalledWith(
        'AdminNotify',
        expect.objectContaining({ dedupeKey: 'frameleaf-cloud:identity-key-expired', level: NotificationLevel.Error }),
      );
      expect(mocks.adminAudit.create).toHaveBeenCalledWith([
        expect.objectContaining({ action: AdminAuditAction.CloudKeyRecoveryRotation, detail: 'window-closed' }),
      ]);
      await expect(access(join(identityDir, ROTATION_NEEDED_FILE))).rejects.toThrow();

      // no more attempts; the relink request stays
      cloud.requests.length = 0;
      makeDue();
      await sut.handleHeartbeat();
      expect(pathsCalled()).not.toContain('POST /api/v1/instance/keys/rotate');
      expect(storedLink()?.heartbeat?.relinkRequested).toBe(true);
    });

    it('asks for a relink without calling the cloud once a day has passed since the key was set aside (FL-175)', async () => {
      const since = Date.now() - 25 * 60 * 60 * 1000;
      await writeFile(
        join(identityDir, ROTATION_NEEDED_FILE),
        JSON.stringify({ since: new Date(since).toISOString(), until: new Date(since + 24 * 60 * 60 * 1000) }),
      );
      cloud.on('POST /api/v1/instance/heartbeat', () => ({ status: 200, body: {} }));
      makeDue();
      await sut.handleHeartbeat();
      expect(pathsCalled()).not.toContain('GET /api/v1/instance/keys/nonce');
      expect(storedLink()?.heartbeat?.relinkRequested).toBe(true);
      await expect(access(join(identityDir, ROTATION_NEEDED_FILE))).rejects.toThrow();
    });

    it('removes the retired key only once its window closed, deciding from disk (FL-175)', async () => {
      cloud.on('POST /api/v1/instance/heartbeat', () => ({
        status: 200,
        body: { commands: [{ id: 'k1', type: 'key.rotate' }] },
      }));
      cloud.on('GET /api/v1/instance/keys/nonce', () => ({ status: 200, body: { nonce: 'nonce-12345' } }));
      cloud.on('POST /api/v1/instance/keys/rotate', () => ({ status: 200, body: {} }));
      cloud.on('POST /api/v1/instance/commands/k1/ack', () => ({ status: 200, body: {} }));
      makeDue();
      await sut.handleHeartbeat();
      await expect(access(join(identityDir, RETIRING_KEY_FILE))).resolves.toBeUndefined();

      cloud.on('POST /api/v1/instance/heartbeat', () => ({ status: 200, body: {} }));
      // the window of this very rotation closed; the stored record is out of date on purpose
      const sidecar = JSON.parse(await readFile(join(identityDir, RETIRING_META_FILE), 'utf8'));
      await writeFile(
        join(identityDir, RETIRING_META_FILE),
        JSON.stringify({ ...sidecar, until: new Date(Date.now() - 1000).toISOString() }),
      );
      makeDue();
      await sut.handleHeartbeat();
      await expect(access(join(identityDir, RETIRING_KEY_FILE))).rejects.toThrow();
      expect((metadata.get(SystemMetadataKey.FrameleafInstance) as FrameleafInstanceIdentity).retiring).toBeUndefined();
    });

    const sutForgetTokens = () =>
      (sut as unknown as { frameleafCloudRepository: FrameleafCloudRepository }).frameleafCloudRepository.forget();
  });

  describe('Sign in with Frameleaf settings (FL-158)', () => {
    it('reports the linked accounts and offers the button at home only once linked', async () => {
      mocks.frameleafAccount.countLinks.mockResolvedValue(3);
      await expect(sut.getStatus()).resolves.toMatchObject({ signInLinkedAccounts: 3, signInShowOnLocalLogin: false });
      await expect(sut.updateSignIn(authStub.admin, { showOnLocalLogin: true })).rejects.toThrow(
        'Link this server first.',
      );

      await linkNow();
      await expect(sut.updateSignIn(authStub.admin, { showOnLocalLogin: true })).resolves.toMatchObject({
        signInShowOnLocalLogin: true,
        signInClientId: 'instance-1',
      });
      await expect(sut.updateSignIn(authStub.admin, { buttonText: 'Use Frameleaf' })).resolves.toMatchObject({
        signInShowOnLocalLogin: true,
        signInButtonText: 'Use Frameleaf',
      });
    });
  });

  describe('unlink (FL-155)', () => {
    it('forgets a pending recovery rotation (FL-175)', async () => {
      await linkNow();
      cloud.on('DELETE /api/v1/instance', () => ({ status: 200, body: {} }));
      await writeFile(join(identityDir, ROTATION_NEEDED_FILE), 'not json');
      await sut.unlink(authStub.admin);
      await expect(access(join(identityDir, ROTATION_NEEDED_FILE))).rejects.toThrow();
    });

    it('tells the cloud, clears the link and switches cloud features off', async () => {
      await linkNow();
      cloud.on('DELETE /api/v1/instance', () => ({ status: 200, body: {} }));
      metadata.set(SystemMetadataKey.SystemConfig, { frameleafCloud: { cloudMl: { enabled: true } } });
      clearConfigCache();

      await expect(sut.unlink(authStub.admin)).resolves.toMatchObject({ state: 'unlinked', account: null });
      expect(pathsCalled()).toContain('DELETE /api/v1/instance');
      expect(storedLink()).toMatchObject({ status: 'unlinked', desired: { remoteAccess: false, cloudBackup: false } });
      expect(storedLink()?.instanceId).toBeUndefined();
      expect(cloudMlEnabled()).toBe(false);
      expect(mocks.adminAudit.create).toHaveBeenCalledWith([
        expect.objectContaining({ action: AdminAuditAction.CloudUnlinked, actorId: authStub.admin.user.id }),
      ]);
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_frameleaf_cloud', admin.id, { topic: 'link' });
    });

    it('ends every Sign in with Frameleaf session, removes the account links and the client secret (FL-158)', async () => {
      await linkNow();
      cloud.on('DELETE /api/v1/instance', () => ({ status: 200, body: {} }));
      metadata.set(SystemMetadataKey.SystemConfig, { frameleafCloud: { signIn: { clientSecret: 'secret' } } });
      clearConfigCache();
      mocks.frameleafAccount.deleteAllSessions.mockResolvedValue(['session-1', 'session-2']);
      mocks.session.delete.mockResolvedValue();

      await sut.unlink(authStub.admin);
      expect(mocks.session.delete).toHaveBeenCalledWith('session-1');
      expect(mocks.session.delete).toHaveBeenCalledWith('session-2');
      expect(mocks.event.emit).toHaveBeenCalledWith('SessionDelete', { sessionId: 'session-2' });
      expect(mocks.frameleafAccount.deleteAllLinks).toHaveBeenCalled();
      const stored = metadata.get(SystemMetadataKey.SystemConfig) as
        { frameleafCloud?: { signIn?: { clientSecret?: string } } } | undefined;
      expect(stored?.frameleafCloud?.signIn?.clientSecret ?? '').toBe('');
    });

    it('unlinks locally even when the cloud cannot be reached', async () => {
      await linkNow();
      cloud.on('DELETE /api/v1/instance', () => ({ status: 503, body: { code: 'down', message: 'down' } }));
      await expect(sut.unlink(authStub.admin)).resolves.toMatchObject({ state: 'unlinked' });
    });
  });
});
