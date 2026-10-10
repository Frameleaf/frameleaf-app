import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrameleafCloudLink, FrameleafInstanceIdentity } from 'src/types.js';
import { MlAdmissionRefusal, SystemMetadataKey } from 'src/enum.js';
import { CloudMlGateway, FrameleafCloudMlRepository } from 'src/repositories/frameleaf-cloud-ml.repository.js';
import { FrameleafCloudRepository, FrameleafCloudRequest } from 'src/repositories/frameleaf-cloud.repository.js';
import {
  CloudConnectionState,
  CloudMlGatewayDeps,
  ML_REGION_MISMATCH_DETAIL,
  REGION_MISMATCH_NOTICE,
  resolveCloudGateway,
} from 'src/utils/frameleaf-cloud-gateway.js';
import { CloudErrorEnvelope, FrameleafCloudError, FrameleafDiscoveryDocument } from 'src/utils/frameleaf-cloud.js';
import { FrameleafKeySigner } from 'src/utils/frameleaf-dpop.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';

/**
 * FC-50 (CLD-201): the ML host is always discovery's `ml.<region>` for the owner's `dataRegion` from
 * the link answer, never a guess. A region refusal (403 `region-mismatch` from the gateway, 400
 * `invalid_target` from the token endpoint) re-reads discovery and the link once and retries once;
 * a second refusal is an administrators' notice and a clear refusal, never a retry loop.
 */
const CLOUD = 'https://frameleaf.cloud.test';
const ML = { eu: 'https://ml.eu.cloud.test', na: 'https://ml.na.cloud.test' };

const discovery = {
  version: 1,
  validFor: 3600,
  issuer: 'https://id.cloud.test',
  api: 'https://api.cloud.test',
  ml: ML,
  regions: ['eu', 'na'],
} as unknown as FrameleafDiscoveryDocument;

const signer: FrameleafKeySigner = {
  kid: 'kid-1',
  publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'x' },
  sign: () => 'signed',
};

const identity: FrameleafInstanceIdentity = {
  instanceId: 'instance-1',
  kid: 'kid-1',
  publicJwk: signer.publicJwk,
  keyFile: '/identity/instance-key.pem',
  createdAt: '2026-09-01T00:00:00.000Z',
};

const regionMismatch = () =>
  new FrameleafCloudError(
    MlAdmissionRefusal.DestinationUnhealthy,
    403,
    'This server’s account belongs to another Frameleaf Cloud region.',
    cloudContractFixture<CloudErrorEnvelope>('errors/region-mismatch.json'),
  );

const invalidTarget = () =>
  new FrameleafCloudError(MlAdmissionRefusal.DestinationUnhealthy, 400, 'invalid target', null, {
    error: 'invalid_target',
  });

describe('Frameleaf Cloud ML region routing (FC-50)', () => {
  let metadata: Map<string, unknown>;
  let cloud: {
    discovery: ReturnType<typeof vi.fn>;
    accessToken: ReturnType<typeof vi.fn>;
    forget: ReturnType<typeof vi.fn>;
    requestJson: ReturnType<typeof vi.fn>;
    requestJsonConditional: ReturnType<typeof vi.fn>;
  };
  let emit: ReturnType<typeof vi.fn>;
  let deps: CloudMlGatewayDeps;

  const link = (dataRegion: string | undefined): FrameleafCloudLink => ({
    status: 'linked',
    cloudUrl: CLOUD,
    instanceId: 'instance-1',
    dataRegion,
  });
  const ready = async () => {
    const resolution = await resolveCloudGateway(deps);
    if (resolution.state !== CloudConnectionState.Ready) {
      throw new Error(`not ready: ${'detail' in resolution ? resolution.detail : ''}`);
    }
    return resolution;
  };
  /** The ML resource of each token request, in order. */
  const tokenResources = () => cloud.accessToken.mock.calls.map((call) => call[2] as string);

  beforeEach(() => {
    metadata = new Map();
    emit = vi.fn(() => Promise.resolve());
    cloud = {
      discovery: vi.fn(() => Promise.resolve(discovery)),
      accessToken: vi.fn((_document: unknown, _instanceId: string, resource: string, key: FrameleafKeySigner) =>
        Promise.resolve({ accessToken: `token for ${resource}`, signer: key }),
      ),
      forget: vi.fn(),
      requestJson: vi.fn(),
      requestJsonConditional: vi.fn(),
    };
    deps = {
      configRepository: { getEnv: () => ({ frameleafCloud: { url: CLOUD, identityDir: '/identity' } }) } as never,
      databaseRepository: { withLock: (_lock: unknown, callback: () => Promise<unknown>) => callback() } as never,
      systemMetadataRepository: {
        get: (key: string) => Promise.resolve(metadata.get(key) ?? null),
        set: (key: string, value: unknown) => Promise.resolve(void metadata.set(key, value)),
        delete: (key: string) => Promise.resolve(void metadata.delete(key)),
      } as never,
      instanceIdentityRepository: {
        loadOrCreate: () => Promise.resolve(identity),
        currentSigner: () => signer,
      } as never,
      frameleafCloudRepository: cloud as unknown as FrameleafCloudRepository,
      eventRepository: { emit: emit as never },
      logger: { warn: vi.fn() },
    };
  });

  describe('host selection', () => {
    it('routes an eu account to discovery’s ml.eu, with a token for that resource', async () => {
      metadata.set(SystemMetadataKey.FrameleafCloudLink, link('eu'));

      const resolution = await ready();

      expect(resolution).toMatchObject({ region: 'eu', gateway: { url: ML.eu } });
      expect(tokenResources()).toEqual([ML.eu]);
    });

    it('routes an na account, Canada included, to discovery’s ml.na', async () => {
      // a Canadian owner's link answer names `na` (Canada is stored in North America until a `ca` region exists)
      metadata.set(SystemMetadataKey.FrameleafCloudLink, link('na'));

      const resolution = await ready();

      expect(resolution).toMatchObject({
        region: 'na',
        gateway: { url: ML.na, token: { accessToken: `token for ${ML.na}` } },
      });
      expect(tokenResources()).toEqual([ML.na]);
    });

    it('never guesses a region: no dataRegion, or one discovery does not offer (ca), asks for no token', async () => {
      for (const region of [undefined, 'ca', 'us']) {
        metadata.set(SystemMetadataKey.FrameleafCloudLink, link(region));
        await expect(resolveCloudGateway(deps)).resolves.toMatchObject({
          state: CloudConnectionState.Unavailable,
          refusal: MlAdmissionRefusal.CloudUnavailable,
        });
      }
      expect(cloud.accessToken).not.toHaveBeenCalled();
    });

    it('takes the host from discovery, not from a fixed address', async () => {
      cloud.discovery.mockResolvedValue({ ...discovery, ml: { eu: 'https://gpu.eu.example.cloud.test/' } });
      metadata.set(SystemMetadataKey.FrameleafCloudLink, link('eu'));

      await expect(ready()).resolves.toMatchObject({ gateway: { url: 'https://gpu.eu.example.cloud.test' } });
    });
  });

  describe('403 region-mismatch from the gateway', () => {
    const ml = () => new FrameleafCloudMlRepository(cloud as unknown as FrameleafCloudRepository);
    const sentUrls = () => cloud.requestJson.mock.calls.map((call) => (call[1] as FrameleafCloudRequest).url);

    it('re-reads discovery and the link, then retries once in the owner’s region', async () => {
      metadata.set(SystemMetadataKey.FrameleafCloudLink, link('eu'));
      const { gateway } = await ready();
      // the link now names the owner's real region (for example after a relink by another worker)
      metadata.set(SystemMetadataKey.FrameleafCloudLink, link('na'));
      cloud.requestJson.mockRejectedValueOnce(regionMismatch()).mockResolvedValueOnce({ items: [] });

      await expect(ml().getWallet(gateway)).resolves.toEqual({ items: [] });

      expect(sentUrls()).toEqual([`${ML.eu}/v2/wallet`, `${ML.na}/v2/wallet`]);
      const retried = cloud.requestJson.mock.calls[1][1] as FrameleafCloudRequest;
      expect(retried.dpop).toEqual({ accessToken: `token for ${ML.na}`, signer });
      expect(cloud.forget).toHaveBeenCalledTimes(1);
      expect(cloud.discovery).toHaveBeenCalledTimes(2);
      expect(tokenResources()).toEqual([ML.eu, ML.na]);
      // the caller's gateway follows, so its next call goes to the right region at once
      expect(gateway).toMatchObject({ url: ML.na, token: { accessToken: `token for ${ML.na}` } });
      expect(emit).not.toHaveBeenCalled();
    });

    it('recovers a conditional job read and keeps the job path', async () => {
      metadata.set(SystemMetadataKey.FrameleafCloudLink, link('eu'));
      const { gateway } = await ready();
      metadata.set(SystemMetadataKey.FrameleafCloudLink, link('na'));
      const jobId = '0192f1b0-1a2b-7c3d-8e4f-5a6b7c8d9e0f';
      cloud.requestJsonConditional
        .mockRejectedValueOnce(regionMismatch())
        .mockResolvedValueOnce({ notModified: true, etag: '"e"', retryAfterSeconds: null });

      await expect(ml().getJobView(gateway, jobId, '"e"')).resolves.toMatchObject({ notModified: true });

      expect(cloud.requestJsonConditional.mock.calls.map((call) => (call[1] as FrameleafCloudRequest).url)).toEqual([
        `${ML.eu}/v2/jobs/${jobId}`,
        `${ML.na}/v2/jobs/${jobId}`,
      ]);
    });

    it('stops after one retry, tells the administrators and refuses with a clear reason', async () => {
      metadata.set(SystemMetadataKey.FrameleafCloudLink, link('eu'));
      const { gateway } = await ready();
      cloud.requestJson.mockRejectedValue(regionMismatch());

      const error = await ml()
        .getCapabilities(gateway)
        .catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(FrameleafCloudError);
      expect(error).toMatchObject({
        message: ML_REGION_MISMATCH_DETAIL,
        status: 403,
        refusal: MlAdmissionRefusal.DestinationUnhealthy,
      });
      // exactly two gateway calls: the first and the one retry, no loop
      expect(cloud.requestJson).toHaveBeenCalledTimes(2);
      expect(cloud.forget).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith('AdminNotify', expect.objectContaining(REGION_MISMATCH_NOTICE));
      expect(metadata.has(SystemMetadataKey.FrameleafMlSuspension)).toBe(false);
    });

    it('passes on the refusal when the re-read gateway cannot be resolved, without a retry', async () => {
      metadata.set(SystemMetadataKey.FrameleafCloudLink, link('eu'));
      const { gateway } = await ready();
      metadata.set(SystemMetadataKey.FrameleafCloudLink, link('ca'));
      cloud.requestJson.mockRejectedValue(regionMismatch());

      await expect(ml().getCatalog(gateway)).rejects.toMatchObject({
        message: expect.stringContaining('(ca)'),
      });
      expect(cloud.requestJson).toHaveBeenCalledTimes(1);
    });

    it('never retries a call a gateway without the hook sent, nor any other refusal', async () => {
      const bare: CloudMlGateway = { url: ML.eu, token: { accessToken: 't', signer } };
      cloud.requestJson.mockRejectedValue(regionMismatch());
      await expect(ml().getWallet(bare)).rejects.toMatchObject({ status: 403 });
      expect(cloud.requestJson).toHaveBeenCalledTimes(1);

      metadata.set(SystemMetadataKey.FrameleafCloudLink, link('eu'));
      const { gateway } = await ready();
      cloud.requestJson.mockReset().mockRejectedValue(
        new FrameleafCloudError(MlAdmissionRefusal.DestinationUnhealthy, 503, 'busy', {
          ...cloudContractFixture<CloudErrorEnvelope>('errors/capacity.json'),
        }),
      );
      await expect(ml().getWallet(gateway)).rejects.toMatchObject({ status: 503 });
      expect(cloud.requestJson).toHaveBeenCalledTimes(1);
      expect(cloud.forget).not.toHaveBeenCalled();
    });
  });

  describe('400 invalid_target from the token endpoint', () => {
    it('re-reads discovery and the link once, then mints for the owner’s region', async () => {
      metadata.set(SystemMetadataKey.FrameleafCloudLink, link('eu'));
      cloud.accessToken.mockImplementationOnce(() => {
        metadata.set(SystemMetadataKey.FrameleafCloudLink, link('na'));
        throw invalidTarget();
      });

      await expect(ready()).resolves.toMatchObject({ region: 'na', gateway: { url: ML.na } });
      expect(tokenResources()).toEqual([ML.eu, ML.na]);
      expect(cloud.forget).toHaveBeenCalledTimes(1);
      expect(emit).not.toHaveBeenCalled();
    });

    it('refuses with a clear reason and one notice when the region is still refused', async () => {
      metadata.set(SystemMetadataKey.FrameleafCloudLink, link('eu'));
      cloud.accessToken.mockRejectedValue(invalidTarget());

      await expect(resolveCloudGateway(deps)).resolves.toMatchObject({
        state: CloudConnectionState.Unavailable,
        refusal: MlAdmissionRefusal.CloudUnavailable,
        detail: ML_REGION_MISMATCH_DETAIL,
      });
      expect(tokenResources()).toEqual([ML.eu, ML.eu]);
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith('AdminNotify', expect.objectContaining(REGION_MISMATCH_NOTICE));
    });
  });
});
