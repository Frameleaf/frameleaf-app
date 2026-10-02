import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FrameleafLicense, FrameleafLicenseClaims, FrameleafRemoteAccess } from 'src/types.js';
import { EdgeCertificateRepository } from 'src/edge/edge-certificate.repository.js';
import { EdgeDirectService } from 'src/edge/edge-direct.service.js';
import { EdgePortMappingService } from 'src/edge/edge-port-mapping.service.js';
import { EdgeProxyService } from 'src/edge/edge-proxy.service.js';
import { EdgeRelayService } from 'src/edge/edge-relay.service.js';
import { EdgeStateService, carrierGradeNat } from 'src/edge/edge-state.service.js';
import { DatabaseLock, SystemMetadataKey } from 'src/enum.js';
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
  let proxy: { destroy: any; configureRecovery: any };
  let relay: { configure: any; ensure: any; stop: any; status: any; state: Record<string, unknown> };
  let portMapping: { keep: any; release: any; result: Record<string, unknown> };
  let wanProbe: Record<string, unknown>;
  let env: { url: string | null; secret: string | null };
  let calls: Array<{ method: string; url: string; body: unknown }>;
  let lockHeld: boolean;
  let wildcard: { certificate: string; key: string };
  let custom: { certificate: string; key: string };
  // The wildcard fixture becomes valid on September 27; recovery checks notBefore as well as expiry.
  const now = Date.UTC(2026, 8, 28, 12);

  const remoteState = () => metadata.get(SystemMetadataKey.FrameleafRemoteAccess) as FrameleafRemoteAccess | undefined;

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
          pushUrl: null,
          identityDir,
          linkToken: null,
          setupCode: null,
          edge: { port: 2443, bind: '0.0.0.0', secret: env.secret, acmeDirectoryUrl: 'https://acme.test/directory' },
          localUrl: 'http://192.168.1.10:2283',
          trustedLanCidrs: [],
          licenseExtraJwksFile: null,
        },
      }),
    );
    mocks.systemMetadata.get.mockImplementation((key) => Promise.resolve((metadata.get(key) ?? null) as never));
    mocks.systemMetadata.set.mockImplementation((key, value) => {
      metadata.set(key, value);
      return Promise.resolve();
    });
    lockHeld = true;
    mocks.database.holdLock.mockImplementation(() =>
      Promise.resolve({
        backendPid: 123,
        verify: () => Promise.resolve(lockHeld),
        release: vi.fn(() => Promise.resolve()),
      }),
    );
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
      if (request.url === `${API}/v1/remote/wan-probe`) {
        return Promise.resolve(schema.parse(wanProbe));
      }
      return Promise.resolve({});
    });
    mocks.user.getAdmins.mockResolvedValue([{ id: 'admin-1' }] as never);
    mocks.notification.findRecentByDedupeKey.mockResolvedValue(false as never);
    mocks.notification.create.mockResolvedValue({} as never);

    metadata.set(SystemMetadataKey.FrameleafCloudLink, { status: 'linked', cloudUrl: CLOUD, instanceId: INSTANCE_ID });
    metadata.set(SystemMetadataKey.FrameleafLicense, { key: null, plan: license(['CLOUD', 'REMOTE_ACCESS'], now) });
    setSettings({ enabled: true });

    const logger = automock(LoggingRepository, { args: [undefined, { getEnv: () => ({}) }], strict: false });
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
    proxy = { destroy: vi.fn(), configureRecovery: vi.fn() };
    relay = {
      state: { connected: false },
      configure: vi.fn(),
      ensure: vi.fn(() => Promise.resolve()),
      stop: vi.fn(() => Promise.resolve()),
      status: vi.fn(() => relay.state),
    };
    wanProbe = cloudContractFixture('remote/wan-probe-response.json');
    portMapping = {
      result: {
        method: 'upnp',
        externalPort: 2443,
        externalIp: '203.0.113.7',
        leaseUntil: null,
        error: null,
        noGateway: false,
      },
      keep: vi.fn(() => Promise.resolve(portMapping.result)),
      release: vi.fn(() => Promise.resolve()),
    };
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
      relay as unknown as EdgeRelayService,
      portMapping as unknown as EdgePortMappingService,
    );
    sut.wait = () => Promise.resolve();
    sut.inContainer = () => true;
    sut.defaultInterfaces = () => [];
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

    it('reads nothing until the migrations have run, waiting for a boot that is migrating', async () => {
      setSettings({ enabled: false });
      mocks.database.isSchemaReady.mockResolvedValue(false);
      await sut.tick(now);
      expect(mocks.database.withLock).toHaveBeenCalledWith(DatabaseLock.Migrations, expect.any(Function));
      expect(mocks.systemMetadata.get).not.toHaveBeenCalled();
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
      expect(mocks.database.holdLock).not.toHaveBeenCalled();
      expect(mocks.frameleafCloud.requestJson).not.toHaveBeenCalled();

      mocks.database.isSchemaReady.mockResolvedValue(true);
      await sut.tick(now);
      expect(remoteState()).toMatchObject({ status: 'off', reason: 'Remote access is off.' });

      // once the schema is there it is not checked again
      mocks.database.withLock.mockClear();
      await sut.tick(now);
      expect(mocks.database.withLock).not.toHaveBeenCalledWith(DatabaseLock.Migrations, expect.any(Function));
    });

    it('leaves remote access to the edge worker that holds the lock', async () => {
      mocks.database.holdLock.mockResolvedValue(null);
      await sut.tick(now);
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
      expect(mocks.frameleafCloud.requestJson).not.toHaveBeenCalled();
    });
  });

  describe('serving', () => {
    it('switches a lapsed plan to recovery only with an existing enrollment, even with new backups disabled', async () => {
      issueWith(wildcard);
      await sut.tick(now);
      const enrollment = remoteState()!.names!;
      const key = { kty: 'OKP', crv: 'Ed25519', x: 'a'.repeat(43) };
      const partner = '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e54';
      const pairId = '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e55';
      const vaultId = '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e56';
      const vault = {
        vaultId,
        sourceInstanceId: partner,
        destinationInstanceId: INSTANCE_ID,
        sourceKey: key,
        destinationKey: key,
        quotaBytes: 10 * 1024 ** 3,
        retention: { days: 30, monthly: 12 },
      };
      const pairing = {
        version: 1,
        pairId,
        state: 'active',
        readUntil: null,
        vaults: [
          vault,
          {
            ...vault,
            vaultId: '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e57',
            sourceInstanceId: INSTANCE_ID,
            destinationInstanceId: partner,
          },
        ],
      };
      await mkdir(join(identityDir, 'buddy'));
      await writeFile(
        join(identityDir, 'buddy', 'state.json'),
        JSON.stringify({ version: 1, settings: null, pairing }),
      );
      metadata.delete(SystemMetadataKey.FrameleafLicense);
      calls.length = 0;
      direct.start.mockClear();
      relay.ensure.mockClear();
      await sut.tick(now + 10_000);
      expect(direct.stop).toHaveBeenCalled();
      expect(direct.start).not.toHaveBeenCalled();
      expect(calls.some(({ url }) => url.endsWith('/enroll'))).toBe(false);
      expect(relay.ensure).toHaveBeenCalledWith(
        expect.objectContaining({
          enrollment,
          recovery: { pairId, vaultId, sourceInstanceId: partner, readUntil: null },
        }),
        now + 10_000,
      );
      expect(proxy.configureRecovery).toHaveBeenLastCalledWith({
        pairId,
        vaultId,
        sourceInstanceId: partner,
        readUntil: null,
        host: `recovery.${enrollment.label}.${enrollment.domain}`,
      });
      expect(remoteState()).toMatchObject({
        status: 'idle',
        candidates: [],
        direct: { listening: false, mapping: null },
      });

      // A configured paid Buddy pair gets direct and relay transport without enabling ordinary remote access.
      vi.stubEnv('FRAMELEAF_BUDDY_BACKUP', 'true');
      try {
        await writeFile(
          join(identityDir, 'buddy', 'state.json'),
          JSON.stringify({
            version: 1,
            pairing,
            settings: { directory: '/buddy', quotaBytes: 10 * 1024 ** 3, pausedReceiving: false },
          }),
        );
        metadata.set(SystemMetadataKey.FrameleafLicense, { key: null, plan: license(['CLOUD', 'REMOTE_ACCESS'], now) });
        setSettings({ enabled: false });
        relay.ensure.mockClear();
        await sut.tick(now + 15_000);
        expect(direct.configure).toHaveBeenLastCalledWith(expect.objectContaining({ allowWan: true }));
        expect(relay.ensure).toHaveBeenCalledWith(expect.objectContaining({ buddyOnly: true }), now + 15_000);
        expect(proxy.configureRecovery).toHaveBeenLastCalledWith(
          expect.objectContaining({ backupEnabled: true, writeAllowed: true }),
          true,
        );
        expect(remoteState()!.candidates.some((candidate) => candidate.kind === 'local')).toBe(true);
        expect(portMapping.keep).toHaveBeenCalled();
        vi.stubEnv('FRAMELEAF_BUDDY_BACKUP', 'false');
        await sut.tick(now + 17_000);
        expect(remoteState()).toMatchObject({ status: 'idle', candidates: [], direct: { listening: false } });
        metadata.delete(SystemMetadataKey.FrameleafLicense);
      } finally {
        vi.unstubAllEnvs();
      }

      // A block learned from durable state removes access on the next edge reconciliation.
      await writeFile(
        join(identityDir, 'buddy', 'state.json'),
        JSON.stringify({ version: 1, pairing: { ...pairing, state: 'blocked' } }),
      );
      relay.ensure.mockClear();
      await sut.tick(now + 20_000);
      expect(proxy.configureRecovery).toHaveBeenLastCalledWith(null, true);
      expect(relay.ensure).not.toHaveBeenCalled();
      expect(relay.stop).toHaveBeenCalled();
    });

    it('enrols, issues the wildcard certificate through the TXT API, reports it and listens', async () => {
      const issue = issueWith(wildcard);
      await sut.tick(now);

      expect(issue).toHaveBeenCalledWith(
        identityDir,
        expect.objectContaining({
          directoryUrl: 'https://acme.test/directory',
          names: ['*.u225vlzhsdlhwh4l.frameleaf.net', 'u225vlzhsdlhwh4l.frameleaf.net'],
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
        names: { label: 'u225vlzhsdlhwh4l', domain: 'frameleaf.net' },
        certificate: { reported: true },
        direct: { listening: true, port: 2443 },
      });
      // the relay name is published only while the tunnel is READY
      expect(state.candidates.map((candidate) => candidate.uri)).toEqual([
        'https://192-168-1-10.u225vlzhsdlhwh4l.frameleaf.net:2443',
      ]);
      // no key or secret is ever part of the state
      expect(JSON.stringify(state)).not.toContain('PRIVATE KEY');
      expect(JSON.stringify(state)).not.toContain(SECRET);
    });

    describe('direct connect (FL-167)', () => {
      const WAN = 'https://203-0-113-7.u225vlzhsdlhwh4l.frameleaf.net:2443';
      const linkWith = (observedIp: string | null) =>
        metadata.set(SystemMetadataKey.FrameleafCloudLink, {
          status: 'linked',
          cloudUrl: CLOUD,
          instanceId: INSTANCE_ID,
          heartbeat: { failures: 0, observedIp },
        });
      const probes = () => calls.filter((call) => call.url === `${API}/v1/remote/wan-probe`);

      beforeEach(() => {
        issueWith(wildcard);
        linkWith('203.0.113.7');
        setSettings({ enabled: true, mode: 'relay-and-direct' });
      });

      it('has the router forward the direct port and publishes the WAN name only once the cloud reached it', async () => {
        await sut.tick(now);
        expect(portMapping.keep).toHaveBeenCalledWith({
          internalHost: '192.168.1.10',
          internalPort: 2443,
          externalPort: 2443,
          now,
        });
        expect(probes()).toEqual([expect.objectContaining({ method: 'POST', body: { port: 2443 } })]);
        const state = remoteState()!;
        expect(state.direct).toMatchObject({
          mapping: { externalPort: 2443, method: 'upnp' },
          externalIp: '203.0.113.7',
          cgnatSuspected: false,
          guidance: null,
          wan: { verified: true, uri: WAN },
        });
        expect(state.candidates.find((candidate) => candidate.kind === 'wan')).toMatchObject({
          uri: WAN,
          verified: true,
        });
      });

      it('publishes an unreached WAN name as unverified and asks again only after an hour', async () => {
        wanProbe = { verified: false, uri: null, reason: 'timeout' };
        await sut.tick(now);
        expect(remoteState()!.candidates.find((candidate) => candidate.kind === 'wan')).toMatchObject({
          uri: WAN,
          verified: false,
        });
        await sut.tick(now + 30 * 60 * 1000);
        expect(probes()).toHaveLength(1);
        await sut.tick(now + 61 * 60 * 1000);
        expect(probes()).toHaveLength(2);
      });

      it('suspects carrier-grade NAT when the router’s address is not the one the cloud sees, and uses the relay', async () => {
        linkWith('198.51.100.20');
        await sut.tick(now);
        expect(remoteState()!.direct.cgnatSuspected).toBe(true);
        expect(remoteState()!.candidates.some((candidate) => candidate.kind === 'wan')).toBe(false);
        expect(probes()).toHaveLength(0);
      });

      it('tells a container with bridge networking what to do when no router answers', async () => {
        portMapping.result = {
          ...portMapping.result,
          method: null,
          externalPort: null,
          externalIp: null,
          noGateway: true,
          error: 'No router answered UPnP or NAT-PMP.',
        };
        await sut.tick(now);
        expect(remoteState()!.direct).toMatchObject({
          mapping: null,
          guidance: 'bridge',
          mappingError: 'No router answered UPnP or NAT-PMP.',
        });
        expect(remoteState()!.candidates.some((candidate) => candidate.kind === 'wan')).toBe(false);
        // the relay is the baseline path and is untouched
        expect(relay.ensure).toHaveBeenCalled();
      });

      it('probes and publishes the port the router gave when it is not the one asked for', async () => {
        portMapping.result = { ...portMapping.result, method: 'nat-pmp', externalPort: 40_000 };
        wanProbe = { verified: true, uri: 'https://203-0-113-7.u225vlzhsdlhwh4l.frameleaf.net:40000', reason: null };
        await sut.tick(now);
        expect(probes()[0].body).toEqual({ port: 40_000 });
        expect(remoteState()!.candidates.find((candidate) => candidate.kind === 'wan')).toMatchObject({
          uri: 'https://203-0-113-7.u225vlzhsdlhwh4l.frameleaf.net:40000',
          verified: true,
        });
      });

      it('publishes the manual port without touching the router', async () => {
        setSettings({ enabled: true, mode: 'relay-and-direct', portMapping: false, directPort: 8443 });
        await sut.tick(now);
        expect(portMapping.keep).not.toHaveBeenCalled();
        expect(portMapping.release).toHaveBeenCalled();
        expect(remoteState()!.direct).toMatchObject({
          mapping: { externalPort: 8443, method: 'manual' },
          externalIp: '203.0.113.7',
        });
        expect(probes()[0].body).toEqual({ port: 8443 });
      });

      it('removes the mapping when direct connections or remote access are turned off', async () => {
        await sut.tick(now);
        setSettings({ enabled: true, mode: 'relay' });
        await sut.tick(now + 10_000);
        expect(portMapping.release).toHaveBeenCalledTimes(1);
        expect(remoteState()!.direct.mapping).toBeNull();
        setSettings({ enabled: false, mode: 'relay-and-direct' });
        await sut.tick(now + 20_000);
        expect(portMapping.release).toHaveBeenCalledTimes(2);
      });

      it.each([
        ['100.64.3.4', null, true],
        ['192.168.0.2', null, true],
        ['203.0.113.7', '203.0.113.7', false],
        ['203.0.113.7', '203.0.113.8', true],
        ['203.0.113.7', null, false],
        [null, '203.0.113.8', false],
      ])('carrier-grade NAT for router %s and check-in %s: %s', (router, observed, expected) => {
        expect(carrierGradeNat(router, observed)).toBe(expected);
      });
    });

    describe('relay tunnel', () => {
      it('keeps the tunnel up for this link with the certificate, and publishes the relay only while READY', async () => {
        issueWith(wildcard);
        metadata.set(SystemMetadataKey.FrameleafCloudLink, {
          status: 'linked',
          cloudUrl: CLOUD,
          instanceId: INSTANCE_ID,
          linkedAt: '2026-09-01T00:00:00.000Z',
        });
        await sut.tick(now);
        expect(relay.configure).toHaveBeenCalledWith({
          contexts: { wildcard, custom: null },
          enrollment: expect.objectContaining({ label: 'u225vlzhsdlhwh4l' }),
        });
        expect(relay.ensure).toHaveBeenCalledWith(
          expect.objectContaining({
            instanceId: INSTANCE_ID,
            linkKey: `${INSTANCE_ID}|2026-09-01T00:00:00.000Z`,
            enrollment: expect.objectContaining({ domain: 'frameleaf.net' }),
          }),
          now,
        );
        expect(remoteState()!.candidates.some((candidate) => candidate.relay)).toBe(false);

        relay.state = { connected: true, relayId: 'eu1', latencyMs: 21 };
        await sut.tick(now + 10_000);
        expect(remoteState()!.relay).toMatchObject({ connected: true, relayId: 'eu1', latencyMs: 21 });
        expect(remoteState()!.candidates.at(-1)).toMatchObject({
          kind: 'relay',
          uri: 'https://r.u225vlzhsdlhwh4l.frameleaf.net',
        });
      });

      it('closes the tunnel when remote access is turned off', async () => {
        issueWith(wildcard);
        await sut.tick(now);
        setSettings({ enabled: false });
        await sut.tick(now + 10_000);
        expect(relay.stop).toHaveBeenCalled();
      });

      it('enrols again when the server is linked again', async () => {
        issueWith(wildcard);
        await sut.tick(now);
        metadata.set(SystemMetadataKey.FrameleafCloudLink, {
          status: 'linked',
          cloudUrl: CLOUD,
          instanceId: INSTANCE_ID,
          linkedAt: '2026-09-26T13:00:00.000Z',
        });
        await sut.tick(now + 10_000);
        expect(calls.filter((call) => call.url.endsWith('/v1/remote/enroll'))).toHaveLength(2);
      });

      it('tells administrators once after 15 minutes without a tunnel', async () => {
        issueWith(wildcard);
        relay.state = {
          connected: false,
          disconnectedSince: new Date(now).toISOString(),
          lastError: 'The relay refused the tunnel: internal',
        };
        await sut.tick(now + 14 * 60 * 1000);
        expect(mocks.notification.create).not.toHaveBeenCalledWith(
          expect.objectContaining({ title: 'Remote access relay disconnected' }),
        );
        await sut.tick(now + 16 * 60 * 1000);
        await sut.tick(now + 17 * 60 * 1000);
        const notices = mocks.notification.create.mock.calls.filter(
          ([notice]) => notice.title === 'Remote access relay disconnected',
        );
        expect(notices).toHaveLength(1);
        expect(notices[0][0]).toMatchObject({
          userId: 'admin-1',
          data: { dedupeKey: 'frameleaf-remote:relay' },
          description: expect.stringContaining('internal'),
        });
      });
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
        ['*.u225vlzhsdlhwh4l.frameleaf.net', 'u225vlzhsdlhwh4l.frameleaf.net'],
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

    it('stops serving when the edge lock was lost with its connection', async () => {
      issueWith(wildcard);
      await sut.tick(now);
      expect(direct.listening).toBe(true);
      lockHeld = false;
      mocks.database.holdLock.mockResolvedValue(null);
      await sut.tick(now + 10_000);
      expect(direct.stop).toHaveBeenCalled();
      expect(direct.listening).toBe(false);
    });

    it('keeps serving when a retired connection took the lock and it is taken straight back', async () => {
      issueWith(wildcard);
      await sut.tick(now);
      lockHeld = false;
      mocks.database.holdLock.mockResolvedValue({ verify: () => Promise.resolve(true), release: vi.fn() } as never);
      await sut.tick(now + 10_000);
      expect(direct.stop).not.toHaveBeenCalled();
      expect(direct.listening).toBe(true);
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
