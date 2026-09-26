import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FrameleafLicense, FrameleafLicenseClaims, FrameleafRemoteAccess } from 'src/types.js';
import { EdgeCertificateRepository } from 'src/edge/edge-certificate.repository.js';
import { EdgeDirectService } from 'src/edge/edge-direct.service.js';
import { EdgeProxyService } from 'src/edge/edge-proxy.service.js';
import { EdgeStateService } from 'src/edge/edge-state.service.js';
import { SystemMetadataKey } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { ServiceMocks, automock, getMocks } from 'test/utils.js';

const CLOUD = 'https://frameleaf.cloud.test';
const API = 'https://api.frameleaf.cloud.test';
const INSTANCE_ID = '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e53';
const SECRET = 'edge-secret-0123456789abcdef';
const HOUR = 60 * 60 * 1000;

/** Test-only self-signed certificates and keys (openssl, P-256), never used anywhere else. */
const FIXTURES = join(import.meta.dirname, '../../test/fixtures/frameleaf-edge');
const fixture = (name: string) => readFile(join(FIXTURES, name), 'utf8');

const license = (entitlements: string[], now: number): FrameleafLicense => {
  const iat = Math.floor(now / 1000);
  const claims: FrameleafLicenseClaims = {
    iss: 'https://id.cloud.test',
    aud: 'frameleaf-server',
    sub: 'account-1',
    iid: INSTANCE_ID,
    ent: entitlements,
    lic_exp: iat + 30 * 86_400,
    iat,
    exp: iat + 7 * 86_400,
  } as FrameleafLicenseClaims;
  return {
    certificate: 'x.y.z',
    kind: 'plan',
    source: 'account',
    kid: 'kid-1',
    claims,
    verifiedAt: new Date(now).toISOString(),
  };
};

describe(EdgeStateService.name, () => {
  let sut: EdgeStateService;
  let mocks: ServiceMocks;
  let metadata: Map<string, unknown>;
  let identityDir: string;
  let certificates: EdgeCertificateRepository;
  let direct: { listening: boolean; configure: any; start: any; stop: any };
  let proxy: { destroy: any };
  let env: { url: string | null; secret: string | null };
  let calls: Array<{ method: string; url: string; body: unknown }>;
  let wildcard: { certificate: string; key: string };
  let custom: { certificate: string; key: string };
  const now = Date.UTC(2026, 8, 26, 12);

  const remoteState = () =>
    metadata.get(SystemMetadataKey.FrameleafRemoteAccess) as FrameleafRemoteAccess | undefined;

  const setSettings = (remoteAccess: Record<string, unknown>) =>
    metadata.set(SystemMetadataKey.SystemConfig, { frameleafCloud: { remoteAccess } });

  beforeEach(async () => {
    mocks = getMocks();
    metadata = new Map();
    calls = [];
    env = { url: CLOUD, secret: SECRET };
    identityDir = await mkdtemp(join(tmpdir(), 'frameleaf-edge-state-'));
    wildcard = { certificate: await fixture('wildcard.cert.pem'), key: await fixture('wildcard.key.pem') };
    custom = { certificate: await fixture('custom.cert.pem'), key: await fixture('custom.key.pem') };

    mocks.config.getEnv.mockImplementation(() =>
      mockEnvData({
        frameleafCloud: {
          url: env.url,
          identityDir,
          linkToken: null,
          edge: { port: 2443, bind: '0.0.0.0', secret: env.secret, acmeDirectoryUrl: 'https://acme.test/directory' },
          localUrl: 'http://192.168.1.10:2283',
          trustedLanCidrs: [],
        },
      }),
    );
    mocks.systemMetadata.get.mockImplementation((key) => Promise.resolve((metadata.get(key) ?? null) as never));
    mocks.systemMetadata.set.mockImplementation((key, value) => {
      metadata.set(key, value);
      return Promise.resolve();
    });
    mocks.database.tryLock.mockResolvedValue(true);
    mocks.instanceIdentity.loadOrCreate.mockResolvedValue({ instanceId: INSTANCE_ID, kid: 'kid-1' } as never);
    mocks.instanceIdentity.currentSigner.mockReturnValue({ kid: 'kid-1' } as never);
    mocks.frameleafCloud.discovery.mockResolvedValue({
      version: 1,
      validFor: 3600,
      issuer: 'https://id.frameleaf.cloud.test',
      api: API,
      ml: {},
    });
    mocks.frameleafCloud.accessToken.mockResolvedValue({ accessToken: 'token', signer: { kid: 'kid-1' } } as never);
    mocks.frameleafCloud.requestJson.mockImplementation((schema: any, request: any) => {
      calls.push({ method: request.method, url: request.url, body: request.body });
      if (request.url === `${API}/v1/remote/enroll`) {
        return Promise.resolve(schema.parse(cloudContractFixture('remote/enroll-response.json')));
      }
      if (request.url === `${API}/v1/remote/dns/txt` && request.method === 'PUT') {
        return Promise.resolve(schema.parse(cloudContractFixture('remote/dns-txt-put-response.json')));
      }
      return Promise.resolve({});
    });
    mocks.user.getAdmins.mockResolvedValue([{ id: 'admin-1' }] as never);
    mocks.notification.findRecentByDedupeKey.mockResolvedValue(false as never);
    mocks.notification.create.mockResolvedValue({} as never);

    metadata.set(SystemMetadataKey.FrameleafCloudLink, { status: 'linked', cloudUrl: CLOUD, instanceId: INSTANCE_ID });
    metadata.set(SystemMetadataKey.FrameleafLicense, { key: null, plan: license(['CLOUD', 'REMOTE_ACCESS'], now) });
    setSettings({ enabled: true });

    const logger = automock(LoggingRepository, { args: [, { getEnv: () => ({}) }], strict: false });
    certificates = new EdgeCertificateRepository(logger);
    direct = {
      listening: false,
      configure: vi.fn(),
      start: vi.fn(() => {
        direct.listening = true;
        return Promise.resolve();
      }),
      stop: vi.fn(() => {
        direct.listening = false;
        return Promise.resolve();
      }),
    };
    proxy = { destroy: vi.fn() };
    sut = new EdgeStateService(
      logger,
      mocks.config as never,
      mocks.database as never,
      mocks.systemMetadata as never,
      mocks.instanceIdentity as never,
      mocks.frameleafCloud as never,
      mocks.forkSchema as never,
      mocks.user as never,
      mocks.notification as never,
      certificates,
      direct as unknown as EdgeDirectService,
      proxy as unknown as EdgeProxyService,
    );
    sut.wait = () => Promise.resolve();
    sut.inContainer = () => true;
  });

  afterEach(async () => {
    await rm(identityDir, { recursive: true, force: true });
  });

  const issueWith = (pair: { certificate: string; key: string }) =>
    vi.spyOn(certificates, 'issue').mockImplementation(async (_dir, request) => {
      await request.onAccount?.('https://acme.test/acme/acct/2');
      await request.setChallenge('LoqXcYV8q5ONbJQxbmR7SCTNo3tiAXDfowyjxAjEuX0');
      await request.removeChallenge('LoqXcYV8q5ONbJQxbmR7SCTNo3tiAXDfowyjxAjEuX0');
      return { ...pair, accountUrl: 'https://acme.test/acme/acct/2' };
    });

  describe('idle', () => {
    it('makes no network call and serves nothing without a link', async () => {
      metadata.delete(SystemMetadataKey.FrameleafCloudLink);
      await sut.tick(now);
      expect(mocks.frameleafCloud.discovery).not.toHaveBeenCalled();
      expect(mocks.frameleafCloud.requestJson).not.toHaveBeenCalled();
      expect(direct.start).not.toHaveBeenCalled();
      expect(remoteState()).toMatchObject({
        status: 'off',
        reason: 'Link this server to a Frameleaf account first.',
        candidates: [],
      });
    });

    it('makes no network call without a remote access entitlement', async () => {
      metadata.set(SystemMetadataKey.FrameleafLicense, { key: null, plan: license(['CLOUD'], now) });
      await sut.tick(now);
      expect(mocks.frameleafCloud.requestJson).not.toHaveBeenCalled();
      expect(remoteState()).toMatchObject({ status: 'idle' });
    });

    it('makes no network call while remote access is off', async () => {
      setSettings({ enabled: false });
      await sut.tick(now);
      expect(mocks.frameleafCloud.requestJson).not.toHaveBeenCalled();
      expect(remoteState()).toMatchObject({ status: 'off', reason: 'Remote access is off.' });
    });

    it('leaves remote access to the edge worker that holds the lock', async () => {
      mocks.database.tryLock.mockResolvedValue(false);
      await sut.tick(now);
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
      expect(mocks.frameleafCloud.requestJson).not.toHaveBeenCalled();
    });
  });

  describe('serving', () => {
    it('enrols, issues the wildcard certificate through the TXT API, reports it and listens', async () => {
      const issue = issueWith(wildcard);
      await sut.tick(now);

      expect(issue).toHaveBeenCalledWith(
        identityDir,
        expect.objectContaining({
          directoryUrl: 'https://acme.test/directory',
          names: ['*.u225vlzhsdlhwh4l.frameleaf-direct.net', 'u225vlzhsdlhwh4l.frameleaf-direct.net'],
          profile: 'tlsserver',
        }),
      );
      expect(calls.map(({ method, url }) => `${method} ${url.replace(API, '')}`)).toEqual([
        'POST /v1/remote/enroll',
        'PUT /v1/remote/caa',
        'PUT /v1/remote/dns/txt',
        'DELETE /v1/remote/dns/txt',
        'POST /v1/remote/certs',
      ]);
      expect(calls[1].body).toEqual({ accountUri: 'https://acme.test/acme/acct/2' });
      expect(calls[2].body).toEqual({
        name: '_acme-challenge.u225vlzhsdlhwh4l',
        value: 'LoqXcYV8q5ONbJQxbmR7SCTNo3tiAXDfowyjxAjEuX0',
      });
      expect(Object.keys(calls[4].body as object)).toEqual(['serial', 'issuer', 'notBefore', 'notAfter', 'names']);
      await expect(certificates.read(identityDir, 'wildcard')).resolves.toEqual(wildcard);
      expect(direct.configure).toHaveBeenCalledWith(expect.objectContaining({ allowWan: false }));
      expect(direct.start).toHaveBeenCalled();

      const state = remoteState()!;
      expect(state).toMatchObject({
        status: 'ready',
        names: { label: 'u225vlzhsdlhwh4l', domain: 'frameleaf-direct.net' },
        certificate: { reported: true },
        direct: { listening: true, port: 2443 },
      });
      expect(state.candidates.map((candidate) => candidate.uri)).toEqual([
        'https://192-168-1-10.u225vlzhsdlhwh4l.frameleaf-direct.net:2443',
        'https://r.u225vlzhsdlhwh4l.frameleaf-direct.net',
      ]);
      // no key or secret is ever part of the state
      expect(JSON.stringify(state)).not.toContain('PRIVATE KEY');
      expect(JSON.stringify(state)).not.toContain(SECRET);
    });

    it('does not issue again until the renewal window, and checks daily', async () => {
      const issue = issueWith(wildcard);
      await sut.tick(now);
      await sut.tick(now + 10_000);
      await sut.tick(now + 2 * 24 * HOUR);
      // the test certificate is valid for ten years: never due
      expect(issue).toHaveBeenCalledTimes(1);
      const next = Date.parse(remoteState()!.certificateIssuance!.nextCheckAt!);
      expect(next - (now + 2 * 24 * HOUR)).toBeGreaterThanOrEqual(24 * HOUR);
      expect(next - (now + 2 * 24 * HOUR)).toBeLessThan(30 * HOUR);
    });

    it('retries a failed issuance after 1 h, then 2 h, with one notice a day', async () => {
      const issue = vi.spyOn(certificates, 'issue').mockRejectedValue(new Error('rate limited'));
      await sut.tick(now);
      expect(remoteState()).toMatchObject({
        status: 'error',
        certificateIssuance: { failures: 1, lastError: 'rate limited' },
      });
      expect(Date.parse(remoteState()!.certificateIssuance!.nextAttemptAt!) - now).toBe(HOUR);
      expect(direct.start).not.toHaveBeenCalled();
      expect(mocks.notification.create).toHaveBeenCalledTimes(1);
      expect(mocks.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: { dedupeKey: 'frameleaf-remote:certificate:wildcard' } }),
      );

      // not retried before the hour
      await sut.tick(now + 30 * 60 * 1000);
      expect(issue).toHaveBeenCalledTimes(1);

      mocks.notification.findRecentByDedupeKey.mockResolvedValue(true as never);
      await sut.tick(now + HOUR);
      expect(issue).toHaveBeenCalledTimes(2);
      expect(Date.parse(remoteState()!.certificateIssuance!.nextAttemptAt!) - (now + HOUR)).toBe(2 * HOUR);
      // deduplicated: no second notice
      expect(mocks.notification.create).toHaveBeenCalledTimes(1);
    });

    it('issues the verified custom hostname’s certificate through the delegated challenge record', async () => {
      setSettings({
        enabled: true,
        customHostname: { host: 'photos.example.com', status: 'verified', checkedAt: null },
      });
      const issue = vi.spyOn(certificates, 'issue').mockImplementation(async (_dir, request) => {
        await request.setChallenge('LoqXcYV8q5ONbJQxbmR7SCTNo3tiAXDfowyjxAjEuX0');
        const pair = request.names[0] === 'photos.example.com' ? custom : wildcard;
        return { ...pair, accountUrl: 'https://acme-v02.api.letsencrypt.org/acme/acct/123456789' };
      });
      await sut.tick(now);

      expect(issue.mock.calls.map(([, request]) => request.names)).toEqual([
        ['*.u225vlzhsdlhwh4l.frameleaf-direct.net', 'u225vlzhsdlhwh4l.frameleaf-direct.net'],
        ['photos.example.com'],
      ]);
      const txt = calls.filter(({ url, method }) => url === `${API}/v1/remote/dns/txt` && method === 'PUT');
      expect(txt.map(({ body }) => (body as { name: string }).name)).toEqual([
        '_acme-challenge.u225vlzhsdlhwh4l',
        '_acme-challenge.u225vlzhsdlhwh4l',
      ]);
      await expect(certificates.read(identityDir, 'custom')).resolves.toEqual(custom);
      expect(direct.configure).toHaveBeenCalledWith(
        expect.objectContaining({ contexts: { wildcard, custom: { host: 'photos.example.com', ...custom } } }),
      );
      expect(remoteState()).toMatchObject({ customCertificate: { host: 'photos.example.com', reported: true } });
    });

    it('refuses an enrolment for another server', async () => {
      mocks.frameleafCloud.requestJson.mockImplementation((schema: any, request: any) =>
        request.url.endsWith('/v1/remote/enroll')
          ? Promise.resolve({
              ...schema.parse(cloudContractFixture('remote/enroll-response.json')),
              label: 'vrnkiab3hth3sp6o',
            })
          : Promise.resolve({}),
      );
      const issue = vi.spyOn(certificates, 'issue');
      await sut.tick(now);
      expect(issue).not.toHaveBeenCalled();
      expect(remoteState()).toMatchObject({ status: 'error' });
      expect(remoteState()!.reason).toContain('another server');
    });

    it('fails closed without the edge secret', async () => {
      env.secret = null;
      await sut.tick(now);
      expect(direct.start).not.toHaveBeenCalled();
      expect(mocks.frameleafCloud.requestJson).not.toHaveBeenCalled();
      expect(remoteState()).toMatchObject({ status: 'error', direct: { listening: false } });
    });
  });

  describe('teardown', () => {
    it('closes the listener and removes the certificates when remote access is turned off', async () => {
      issueWith(wildcard);
      await sut.tick(now);
      expect(direct.listening).toBe(true);

      setSettings({ enabled: false });
      await sut.tick(now + 10_000);
      expect(direct.stop).toHaveBeenCalled();
      await expect(certificates.read(identityDir, 'wildcard')).resolves.toBeNull();
      expect(remoteState()).toMatchObject({ status: 'off', candidates: [], direct: { listening: false } });
    });

    it('closes the listener and removes the certificates when the server is unlinked', async () => {
      issueWith(wildcard);
      await sut.tick(now);
      metadata.set(SystemMetadataKey.FrameleafCloudLink, { status: 'unlinked', cloudUrl: CLOUD });
      await sut.tick(now + 10_000);
      expect(direct.stop).toHaveBeenCalled();
      await expect(certificates.read(identityDir, 'wildcard')).resolves.toBeNull();
      expect(remoteState()!.names).toBeUndefined();
    });

    it('keeps the certificates when only the entitlement lapsed', async () => {
      issueWith(wildcard);
      await sut.tick(now);
      metadata.set(SystemMetadataKey.FrameleafLicense, { key: null, plan: license(['CLOUD'], now) });
      await sut.tick(now + 10_000);
      expect(direct.stop).toHaveBeenCalled();
      await expect(certificates.read(identityDir, 'wildcard')).resolves.toEqual(wildcard);
    });

    it('closes every socket within 5 seconds on shutdown', async () => {
      issueWith(wildcard);
      await sut.tick(now);
      const started = Date.now();
      await sut.shutdown();
      expect(Date.now() - started).toBeLessThan(5000);
      expect(direct.stop).toHaveBeenCalledWith(expect.any(Number));
      expect(direct.stop.mock.calls[0][0]).toBeLessThanOrEqual(5000);
      expect(proxy.destroy).toHaveBeenCalled();
      // no pass runs after shutdown
      await sut.tick(now + 10_000);
      expect(direct.start).toHaveBeenCalledTimes(1);
    });
  });
});
