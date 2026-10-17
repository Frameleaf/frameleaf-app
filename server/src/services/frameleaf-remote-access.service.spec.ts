import type { FrameleafLicense, FrameleafLicenseClaims, FrameleafRemoteAccess } from 'src/types.js';
import { MlAdmissionRefusal, SystemMetadataKey } from 'src/enum.js';
import { FrameleafRemoteAccessService } from 'src/services/frameleaf-remote-access.service.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const CLOUD = 'https://frameleaf.cloud.test';
const API = 'https://api.frameleaf.cloud.test';
const INSTANCE_ID = '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e53';

const license = (entitlements: string[]): FrameleafLicense => {
  const iat = Math.floor(Date.now() / 1000);
  return {
    certificate: 'x.y.z',
    kind: 'plan',
    source: 'account',
    kid: 'kid-1',
    claims: {
      iss: 'https://id.cloud.test',
      aud: 'frameleaf-server',
      sub: 'account-1',
      iid: INSTANCE_ID,
      ent: entitlements,
      lic_exp: iat + 30 * 86_400,
      iat,
      exp: iat + 7 * 86_400,
    } as FrameleafLicenseClaims,
    verifiedAt: new Date().toISOString(),
  };
};

describe(FrameleafRemoteAccessService.name, () => {
  let sut: FrameleafRemoteAccessService;
  let mocks: ServiceMocks;
  let metadata: Map<string, unknown>;
  let calls: Array<{ method?: string; url: string; body?: unknown }>;

  const remoteSettings = () =>
    (metadata.get(SystemMetadataKey.SystemConfig) as { frameleafCloud?: { remoteAccess?: Record<string, any> } })
      ?.frameleafCloud?.remoteAccess ?? {};

  const edgeState = (overrides: Partial<FrameleafRemoteAccess> = {}): FrameleafRemoteAccess => {
    const answer = cloudContractFixture('remote/enroll-response.json');
    return {
      status: 'ready',
      bootId: 'boot-1',
      updatedAt: new Date().toISOString(),
      reason: null,
      names: { ...answer, cloudUrl: CLOUD, instanceId: INSTANCE_ID, enrolledAt: new Date().toISOString() },
      certificate: {
        names: ['*.u225vlzhsdlhwh4l.frameleaf.net', 'u225vlzhsdlhwh4l.frameleaf.net'],
        serial: '41f9a',
        issuer: 'CN=R11',
        notBefore: new Date(Date.now() - 86_400_000).toISOString(),
        notAfter: new Date(Date.now() + 40 * 86_400_000).toISOString(),
        reported: true,
      },
      relay: { connected: false },
      direct: { listening: true, port: 2443, mapping: null, cgnatSuspected: false },
      candidates: [],
      ...overrides,
    };
  };

  beforeEach(() => {
    ({ sut, mocks } = newTestService(FrameleafRemoteAccessService));
    metadata = new Map();
    calls = [];
    const env = mockEnvData({});
    mocks.config.getEnv.mockReturnValue({ ...env, frameleafCloud: { ...env.frameleafCloud, url: CLOUD } });
    mocks.systemMetadata.get.mockImplementation((key) => Promise.resolve((metadata.get(key) ?? null) as never));
    mocks.systemMetadata.set.mockImplementation((key, value) => {
      metadata.set(key, value);
      return Promise.resolve();
    });
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
      const list = cloudContractFixture('remote/hostnames-list.json');
      if (request.url === `${API}/v1/remote/hostnames` && request.method === 'PUT') {
        return Promise.resolve(schema.parse(list.hostnames[0]));
      }
      if (request.url === `${API}/v1/remote/hostnames`) {
        return Promise.resolve(schema.parse(list));
      }
      if (request.url === `${API}/v1/remote/usage`) {
        return Promise.resolve(schema.parse(cloudContractFixture('remote/remote-usage.json')));
      }
      return Promise.resolve({});
    });

    metadata.set(SystemMetadataKey.FrameleafCloudLink, { status: 'linked', cloudUrl: CLOUD, instanceId: INSTANCE_ID });
    metadata.set(SystemMetadataKey.FrameleafLicense, { key: null, plan: license(['CLOUD', 'REMOTE_ACCESS']) });
  });

  describe('status', () => {
    it('says why remote access cannot be turned on, as the prototype does', async () => {
      metadata.set(SystemMetadataKey.FrameleafLicense, { key: null, plan: license(['CLOUD']) });
      await expect(sut.getStatus()).resolves.toMatchObject({
        unavailableReason: 'Remote access is included with a Frameleaf Cloud plan.',
        enabled: false,
        status: 'off',
      });
      metadata.delete(SystemMetadataKey.FrameleafCloudLink);
      await expect(sut.getStatus()).resolves.toMatchObject({
        unavailableReason: 'Link this server to a Frameleaf account first.',
      });
    });

    it('shows what the edge worker reports, and "unknown" when it stopped reporting', async () => {
      metadata.set(SystemMetadataKey.SystemConfig, { frameleafCloud: { remoteAccess: { enabled: true } } });
      metadata.set(SystemMetadataKey.FrameleafRemoteAccess, edgeState());
      await expect(sut.getStatus()).resolves.toMatchObject({
        status: 'ready',
        publicUrl: 'https://r.u225vlzhsdlhwh4l.frameleaf.net',
        frameleafAddress: 'https://r.u225vlzhsdlhwh4l.frameleaf.net',
        certificateName: '*.u225vlzhsdlhwh4l.frameleaf.net',
        relayRegion: 'eu1',
        directListening: true,
      });
      metadata.set(
        SystemMetadataKey.FrameleafRemoteAccess,
        edgeState({ updatedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() }),
      );
      await expect(sut.getStatus()).resolves.toMatchObject({ status: 'unknown', directListening: false });
    });
  });

  describe('direct connect (FL-167)', () => {
    const direct = (overrides: Record<string, unknown>) =>
      edgeState({ direct: { listening: true, port: 2443, cgnatSuspected: false, ...overrides } } as never);

    beforeEach(() => {
      metadata.set(SystemMetadataKey.SystemConfig, {
        frameleafCloud: { remoteAccess: { enabled: true, mode: 'relay-and-direct' } },
      });
    });

    it('shows the router mapping, the public address and whether Frameleaf Cloud reached it', async () => {
      metadata.set(
        SystemMetadataKey.FrameleafRemoteAccess,
        direct({
          mapping: { externalPort: 2443, method: 'upnp' },
          externalIp: '203.0.113.7',
          wan: {
            key: '203.0.113.7:2443',
            uri: 'https://203-0-113-7.u225vlzhsdlhwh4l.frameleaf.net:2443',
            verified: true,
            reason: null,
            checkedAt: new Date().toISOString(),
          },
        }),
      );
      await expect(sut.getStatus()).resolves.toMatchObject({
        mappingMethod: 'upnp',
        directExternalIp: '203.0.113.7',
        wanAddress: 'https://203-0-113-7.u225vlzhsdlhwh4l.frameleaf.net:2443',
        wanVerified: true,
        wanProblem: null,
        directGuidance: null,
      });
    });

    it('explains bridge networking and CGNAT in the connection test', async () => {
      vi.spyOn(sut as unknown as { probeEdge: () => Promise<unknown> }, 'probeEdge').mockResolvedValue({
        ok: true,
        detail: 'ok',
      });
      metadata.set(
        SystemMetadataKey.FrameleafRemoteAccess,
        direct({ mapping: null, guidance: 'bridge', mappingError: 'No router answered UPnP or NAT-PMP.' }),
      );
      const bridged = await sut.test(authStub.admin);
      expect(bridged.directGuidance).toBe('bridge');
      expect(bridged.lastTestChecks.find((check) => check.id === 'direct')).toMatchObject({
        ok: false,
        detail: expect.stringContaining('host networking'),
      });

      metadata.set(SystemMetadataKey.FrameleafRemoteAccess, direct({ cgnatSuspected: true }));
      const shared = await sut.test(authStub.admin);
      expect(shared.cgnatSuspected).toBe(true);
      expect(shared.lastTestChecks.find((check) => check.id === 'direct')?.detail).toContain(
        'The relay is used instead',
      );
    });
  });

  describe('update', () => {
    it('turns remote access on only on a linked, entitled server, and keeps the link in step', async () => {
      metadata.set(SystemMetadataKey.FrameleafLicense, { key: null, plan: license(['CLOUD']) });
      await expect(sut.update(authStub.admin, { enabled: true })).rejects.toThrow(
        'Remote access is included with a Frameleaf Cloud plan.',
      );
      metadata.set(SystemMetadataKey.FrameleafLicense, { key: null, plan: license(['CLOUD', 'REMOTE_ACCESS']) });

      await sut.update(authStub.admin, { enabled: true, mode: 'relay-and-direct', directPort: 4443 });
      expect(remoteSettings()).toMatchObject({ enabled: true, mode: 'relay-and-direct', directPort: 4443 });
      expect(metadata.get(SystemMetadataKey.FrameleafCloudLink)).toMatchObject({ desired: { remoteAccess: true } });
      expect(mocks.event.emit).toHaveBeenCalledWith('ConfigUpdate', expect.anything());

      // turning it off always works
      metadata.delete(SystemMetadataKey.FrameleafLicense);
      await sut.update(authStub.admin, { enabled: false });
      expect(remoteSettings().enabled ?? false).toBe(false);
    });

    it('publishes the custom hostname only once it is verified', async () => {
      await expect(sut.update(authStub.admin, { publicUrl: 'custom' })).rejects.toThrow(
        'Use my domain needs a custom hostname that Frameleaf Cloud verified.',
      );
      metadata.set(SystemMetadataKey.SystemConfig, {
        frameleafCloud: {
          remoteAccess: { customHostname: { host: 'photos.example.com', status: 'verified', checkedAt: null } },
        },
      });
      await sut.update(authStub.admin, { publicUrl: 'custom' });
      expect(remoteSettings().publicUrl).toBe('custom');
    });
  });

  describe('custom hostname', () => {
    it('refuses Frameleaf’s own domains and hostnames that are not a subdomain', async () => {
      for (const hostname of ['photos.frameleaf.net', 'x.frameleaf-direct.net', 'id.frameleaf.cloud', 'example.com']) {
        await expect(sut.setCustomHostname(authStub.admin, { hostname })).rejects.toThrow();
      }
      expect(calls).toEqual([]);
    });

    it('adds the hostname to Frameleaf Cloud, shows its two records and waits for DNS', async () => {
      metadata.set(SystemMetadataKey.FrameleafRemoteAccess, edgeState());
      const status = await sut.setCustomHostname(authStub.admin, { hostname: 'Photos.Example.com' });
      expect(calls).toEqual([
        {
          method: 'PUT',
          url: `${API}/v1/remote/hostnames`,
          body: cloudContractFixture('remote/hostname-put-request.json'),
        },
      ]);
      const { hostnames } = cloudContractFixture('remote/hostnames-list.json');
      expect(status).toMatchObject({ customHostname: 'photos.example.com', customHostnameStatus: 'pending' });
      expect(status.customHostnameRecords.map(({ type, name, value }) => ({ type, name, value }))).toEqual(
        hostnames[0].records,
      );
      // the stored config holds only what differs from the defaults, and `pending` is the default status
      expect(remoteSettings().customHostname).toMatchObject({ host: 'photos.example.com' });
      expect(remoteSettings().customHostname.status ?? 'pending').toBe('pending');
    });

    it('moves from pending to verified once Frameleaf Cloud sees both records', async () => {
      metadata.set(SystemMetadataKey.SystemConfig, {
        frameleafCloud: {
          remoteAccess: { customHostname: { host: 'family.example.org', status: 'pending', checkedAt: null } },
        },
      });
      const status = await sut.checkCustomHostname(authStub.admin);
      expect(calls.map(({ method, url }) => `${method ?? 'GET'} ${url}`)).toEqual([`GET ${API}/v1/remote/hostnames`]);
      expect(status).toMatchObject({
        customHostnameStatus: 'verified',
        customHostnameCheckedAt: '2026-09-25T17:05:00.000Z',
      });
    });

    it('removes the hostname at Frameleaf Cloud and publishes the Frameleaf address again', async () => {
      metadata.set(SystemMetadataKey.SystemConfig, {
        frameleafCloud: {
          remoteAccess: {
            publicUrl: 'custom',
            customHostname: { host: 'family.example.org', status: 'verified', checkedAt: null },
          },
        },
      });
      await sut.removeCustomHostname(authStub.admin);
      expect(calls).toEqual([
        { method: 'DELETE', url: `${API}/v1/remote/hostnames/family.example.org`, body: undefined },
      ]);
      expect(remoteSettings().publicUrl ?? 'frameleaf').toBe('frameleaf');
      expect(remoteSettings().customHostname?.host ?? '').toBe('');
    });

    it('refuses an answer for another hostname', async () => {
      mocks.frameleafCloud.requestJson.mockImplementation((schema: any) =>
        Promise.resolve(schema.parse(cloudContractFixture('remote/hostnames-list.json').hostnames[1])),
      );
      await expect(sut.setCustomHostname(authStub.admin, { hostname: 'photos.example.com' })).rejects.toThrow(
        'Frameleaf Cloud answered for another hostname.',
      );
      expect(remoteSettings().customHostname?.host ?? '').toBe('');
    });

    it('removes the hostname here even when Frameleaf Cloud cannot be told', async () => {
      metadata.set(SystemMetadataKey.SystemConfig, {
        frameleafCloud: {
          remoteAccess: { customHostname: { host: 'family.example.org', status: 'verified', checkedAt: null } },
        },
      });
      mocks.frameleafCloud.requestJson.mockRejectedValue(
        new FrameleafCloudError(MlAdmissionRefusal.CloudUnavailable, 503, 'maintenance'),
      );
      await expect(sut.removeCustomHostname(authStub.admin)).resolves.toMatchObject({ customHostname: null });
      expect(remoteSettings().customHostname?.host ?? '').toBe('');
    });

    it('says Frameleaf Cloud is unavailable in plain words', async () => {
      mocks.frameleafCloud.requestJson.mockRejectedValue(
        new FrameleafCloudError(MlAdmissionRefusal.CloudUnavailable, 503, 'maintenance'),
      );
      await expect(sut.setCustomHostname(authStub.admin, { hostname: 'photos.example.com' })).rejects.toThrow(
        'Frameleaf Cloud did not complete the request: maintenance',
      );
    });
  });

  describe('relay use this month', () => {
    it('asks Frameleaf Cloud for this month’s relay use and the allowance with the instance token', async () => {
      const usage = await sut.getUsage(authStub.admin);

      expect(calls).toEqual([{ method: undefined, url: `${API}/v1/remote/usage`, body: undefined }]);
      expect(mocks.frameleafCloud.requestJson).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ dpop: expect.objectContaining({ accessToken: 'token' }) }),
      );
      expect(usage).toEqual({
        period: '2026-09',
        periodStart: '2026-09-01T00:00:00.000Z',
        periodEnd: '2026-10-01T00:00:00.000Z',
        bytes: 171_798_691_840,
        limitBytes: 214_748_364_800,
        throttled: false,
        throttleBps: null,
        throttleUntil: null,
      });
    });

    it('says when the relay is slowed down for the rest of the month', async () => {
      mocks.frameleafCloud.requestJson.mockImplementation((schema: any) =>
        Promise.resolve(
          schema.parse({
            ...cloudContractFixture('remote/remote-usage.json'),
            bytes: 214_748_364_800,
            throttle: { bps: 1_000_000, until: '2026-10-01T00:00:00.000Z' },
          }),
        ),
      );
      await expect(sut.getUsage(authStub.admin)).resolves.toMatchObject({
        throttled: true,
        throttleBps: 1_000_000,
        throttleUntil: '2026-10-01T00:00:00.000Z',
      });
    });

    it('contacts nothing before the server is linked', async () => {
      metadata.delete(SystemMetadataKey.FrameleafCloudLink);
      await expect(sut.getUsage(authStub.admin)).rejects.toThrow('Link this server to a Frameleaf account first.');
      expect(calls).toEqual([]);
      expect(mocks.frameleafCloud.discovery).not.toHaveBeenCalled();
    });

    it('asks Frameleaf Cloud at most once a minute', async () => {
      await sut.getUsage(authStub.admin);
      await sut.getUsage(authStub.admin);
      expect(calls).toHaveLength(1);
    });

    it('refuses an answer that does not match the contract', async () => {
      mocks.frameleafCloud.requestJson.mockImplementation((schema: any) =>
        Promise.resolve(schema.parse({ period: '2026-09', bytes: -1 })),
      );
      await expect(sut.getUsage(authStub.admin)).rejects.toThrow();
    });
  });

  describe('self-check', () => {
    beforeEach(() => {
      metadata.set(SystemMetadataKey.SystemConfig, { frameleafCloud: { remoteAccess: { enabled: true } } });
    });

    it('checks the certificate, the listener and a request through it, and keeps the result', async () => {
      metadata.set(SystemMetadataKey.FrameleafRemoteAccess, edgeState());
      const probe = vi
        .spyOn(sut as unknown as { probeEdge: () => Promise<unknown> }, 'probeEdge')
        .mockResolvedValue({ ok: true, detail: 'answered' });
      const status = await sut.test(authStub.admin);
      expect(probe).toHaveBeenCalledWith('127.0.0.1', 2443, '127-0-0-1.u225vlzhsdlhwh4l.frameleaf.net');
      expect(status.lastTestOk).toBe(true);
      expect(status.lastTestChecks.map(({ id, ok }) => [id, ok])).toEqual([
        ['certificate', true],
        ['listener', true],
        ['api', true],
        ['relay', false],
      ]);
      // kept under its own key, which the edge worker never writes
      expect(metadata.get(SystemMetadataKey.FrameleafRemoteAccessTest)).toMatchObject({ ok: true });
    });

    it('fails without a certificate or a listener, without trying the request', async () => {
      metadata.set(
        SystemMetadataKey.FrameleafRemoteAccess,
        edgeState({ certificate: null, direct: { listening: false, port: 2443, cgnatSuspected: false } }),
      );
      const probe = vi.spyOn(sut as unknown as { probeEdge: () => Promise<unknown> }, 'probeEdge');
      const status = await sut.test(authStub.admin);
      expect(probe).not.toHaveBeenCalled();
      expect(status.lastTestOk).toBe(false);
    });

    it('needs remote access on', async () => {
      metadata.set(SystemMetadataKey.SystemConfig, { frameleafCloud: { remoteAccess: { enabled: false } } });
      await expect(sut.test(authStub.admin)).rejects.toThrow('Turn remote access on first.');
    });
  });
});
