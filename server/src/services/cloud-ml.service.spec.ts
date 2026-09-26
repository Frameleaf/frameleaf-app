import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaults } from 'src/config.js';
import {
  ImmichWorker,
  MlAdmissionRefusal,
  MlDestinationKind,
  MlWorkload,
  NotificationLevel,
  NotificationType,
  SystemMetadataKey,
} from 'src/enum.js';
import { CloudMlService, WALLET_STEP_UP_MESSAGE } from 'src/services/cloud-ml.service.js';
import {
  FrameleafCloudError,
  capabilitiesSchema,
  catalogSchema,
  consentCurrentSchema,
  usageSchema,
} from 'src/utils/frameleaf-cloud.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';
import { mlDestinationStub } from 'test/fixtures/ml-destination.stub.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

/** The identity key's signer (FL-178): the key the ML token is bound to and every proof is signed with. */
const identitySigner = {
  kid: 'kid-1',
  publicJwk: { kty: 'OKP' as const, crv: 'Ed25519' as const, x: 'x' },
  sign: () => 'header.payload.signature',
};

/**
 * FL-183: the gateway's own capabilities.json, with a wallet and two workload IDs this server never
 * serves (a local-only one and an unknown one) so the probe is seen to drop them.
 */
const capabilities = capabilitiesSchema.parse({
  ...cloudContractFixture<Record<string, unknown>>('ml/capabilities.json'),
  workloads: ['descriptions', 'restoration', 'face', 'teleportation'],
  wallet: { balanceUsd: 12, heldUsd: 2, dailyCapUsd: null, spentTodayUsd: 0 },
});

type CatalogFixture = { etag: string | null; models: Array<Record<string, unknown>> };
const catalogFixture = cloudContractFixture<CatalogFixture>('ml/catalog.json');
const restorationFixture = cloudContractFixture<CatalogFixture>('ml/catalog-restoration.json');

/**
 * The gateway's catalog.json plus the faithful restoration model of catalog-restoration.json (FL-181
 * P1: this catalogue confirms a faithful restoration model, but no creative one), a model that runs on
 * this server only (FL-146) and an entry the contract refuses.
 */
const catalog = catalogSchema.parse({
  ...catalogFixture,
  models: [
    ...catalogFixture.models,
    { ...catalogFixture.models[0], sku: 'ms_ZZZZZZZZ', display: { model: 'Qwen2.5-VL-3B-Instruct', gpu: 'Any' } },
    restorationFixture.models.find((model) => model.mode === 'faithful'),
    cloudContractFixture('ml/rejected/catalog-entry-model-id.json'),
  ],
});

const consentCurrent = consentCurrentSchema.parse({
  ...cloudContractFixture<Record<string, unknown>>('ml/consent-current.json'),
  requiredVersion: '2026-10-01.1',
  recordedVersion: '2026-09-25',
  summary: 'Media is processed in the EU region.',
});

describe(CloudMlService.name, () => {
  let sut: CloudMlService;
  let mocks: ServiceMocks;
  let metadata: Map<string, unknown>;

  const allBoth = { descriptions: 'both', upscale: 'both', restoration: 'both', studio: 'both', interpolation: 'both' };
  const configure = ({
    cloudMlEnabled = true,
    url = 'https://cloud.test' as string | null,
    routing = allBoth as Record<string, string>,
  } = {}) => {
    mocks.config.getEnv.mockReturnValue({
      ...mocks.config.getEnv(),
      frameleafCloud: { ...mocks.config.getEnv().frameleafCloud, url, identityDir: '/tmp/identity' },
    });
    mocks.systemMetadata.get.mockImplementation((key) =>
      Promise.resolve(
        (key === SystemMetadataKey.SystemConfig
          ? { frameleafCloud: { cloudMl: { ...defaults.frameleafCloud.cloudMl, enabled: cloudMlEnabled, routing } } }
          : (metadata.get(key) ?? null)) as never,
      ),
    );
  };

  const link = () =>
    metadata.set(SystemMetadataKey.FrameleafCloudLink, {
      status: 'linked',
      cloudUrl: 'https://cloud.test',
      instanceId: 'instance-1',
      dataRegion: 'eu',
    });

  beforeEach(() => {
    ({ sut, mocks } = newTestService(CloudMlService));
    metadata = new Map();
    mocks.systemMetadata.set.mockImplementation((key, value) => {
      metadata.set(key, value);
      return Promise.resolve();
    });
    mocks.systemMetadata.delete.mockImplementation((key) => {
      metadata.delete(key);
      return Promise.resolve();
    });
    mocks.database.withLock.mockImplementation((_lock, callback) => callback() as never);
    mocks.instanceIdentity.loadOrCreate.mockResolvedValue({
      instanceId: 'instance-1',
      kid: 'kid-1',
      publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'x' },
      keyFile: '/tmp/identity/instance-key.pem',
      createdAt: '2026-09-25T00:00:00.000Z',
    });
    mocks.frameleafCloud.discovery.mockResolvedValue({
      version: 1,
      validFor: 3600,
      issuer: 'https://id.cloud.test',
      api: 'https://api.cloud.test',
      ml: { eu: 'https://ml.eu.cloud.test' },
    });
    mocks.instanceIdentity.currentSigner.mockReturnValue(identitySigner);
    mocks.frameleafCloud.accessToken.mockResolvedValue({ accessToken: 'ml-token', signer: identitySigner });
    mocks.frameleafCloudMl.ping.mockResolvedValue();
    mocks.frameleafCloudMl.getCapabilities.mockResolvedValue(capabilities);
    mocks.frameleafCloudMl.getHardware.mockResolvedValue({
      providers: ['CUDAExecutionProvider'],
      cudaDeviceCount: 1,
      preferredAcceleration: 'cuda',
    });
    mocks.frameleafCloudMl.getCatalog.mockResolvedValue(catalog);
    mocks.frameleafCloudMl.getWallet.mockResolvedValue({
      balanceUsd: 12,
      heldUsd: 2,
      dailyCapUsd: null,
      spentTodayUsd: 0,
      topUpUrl: 'https://account.cloud.test/wallet',
      autoTopUp: false,
      settingsUrl: null,
    });
    mocks.frameleafCloudMl.getConsent.mockResolvedValue(consentCurrent);
    mocks.frameleafCloudMl.getUsage.mockResolvedValue({ items: [] });
    mocks.mlDestination.getAll.mockResolvedValue([mlDestinationStub.local]);
    mocks.mlDestination.getSpend.mockResolvedValue(0);
    mocks.mlDestination.applySettlements.mockResolvedValue(0);
    mocks.mlDestination.create.mockImplementation((row) =>
      Promise.resolve({ ...mlDestinationStub.frameleafCloud, ...row, id: 'created' } as never),
    );
    configure();
  });

  describe('probe', () => {
    it('refuses without contacting anything while Frameleaf Cloud processing is turned off', async () => {
      configure({ cloudMlEnabled: false });
      link();

      const probe = await sut.probe();

      expect(probe.reachable).toBe(false);
      expect(probe.cloud?.refusal?.refusal).toBe(MlAdmissionRefusal.CloudUnavailable);
      expect(mocks.frameleafCloud.discovery).not.toHaveBeenCalled();
    });

    it('refuses without contacting anything while the server is not linked', async () => {
      const probe = await sut.probe();

      expect(probe).toMatchObject({ reachable: false, error: 'This server is not linked to a Frameleaf account' });
      expect(probe.cloud?.refusal?.refusal).toBe(MlAdmissionRefusal.CloudUnavailable);
      expect(mocks.frameleafCloud.discovery).not.toHaveBeenCalled();
    });

    it('reports what the gateway offers, never faces or unknown work, with the facts admission needs', async () => {
      link();

      const probe = await sut.probe();

      expect(probe.reachable).toBe(true);
      // The catalogue confirms a faithful restoration model but no creative one (FL-181 P1): a
      // restoration mode is only offered once the catalogue names a usable model for it, never on
      // the capability alone.
      expect(probe.workloads).toEqual([MlWorkload.Enrichment, MlWorkload.RestorationFaithful]);
      expect(probe.hardware).toMatchObject({ cudaDeviceCount: 1, torchCudaAvailable: true });
      // FL-183: the catalogue's model identity is the SKU; the local-only model and the entry the
      // contract refuses are never offered
      expect(probe.cloud).toMatchObject({
        region: 'eu',
        entitled: true,
        consentRequiredVersion: '2026-09-26.1',
        balanceUsd: 12,
        heldUsd: 2,
        limits: { maxInputBytes: 2_147_483_648, maxInputs: 1000, concurrentTimePriced: 2 },
        modelIds: ['ms_K6WT70CS', 'ms_M7QG26PT', 'ms_54S55W7C', 'ms_YS60DAXB'],
        modelWorkloads: {
          ms_K6WT70CS: MlWorkload.Enrichment,
          ms_M7QG26PT: MlWorkload.Enrichment,
          ms_54S55W7C: MlWorkload.Upscale,
          ms_YS60DAXB: MlWorkload.RestorationFaithful,
        },
        refusal: null,
      });
      expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/1 catalogue entry this server does not/));
      expect(metadata.get(SystemMetadataKey.FrameleafMlWallet)).toMatchObject({ balanceUsd: 12, heldUsd: 2 });
      expect(mocks.frameleafCloudMl.getCapabilities).toHaveBeenCalledWith({
        url: 'https://ml.eu.cloud.test',
        token: { accessToken: 'ml-token', signer: identitySigner },
      });
    });

    it('serves only the work set to Both or Cloud only in Where each job runs', async () => {
      link();
      configure({ routing: { ...allBoth, restoration: 'local' } });

      const probe = await sut.probe();

      expect(probe.workloads).toEqual([MlWorkload.Enrichment]);
    });

    it('offers both restoration modes once the catalogue confirms a usable model for each (FL-181 P1)', async () => {
      link();
      mocks.frameleafCloudMl.getCatalog.mockResolvedValue(catalogSchema.parse(restorationFixture));

      const probe = await sut.probe();

      expect(probe.workloads).toEqual([
        MlWorkload.Enrichment,
        MlWorkload.RestorationFaithful,
        MlWorkload.RestorationCreative,
      ]);
      expect(probe.cloud?.modelWorkloads).toEqual({
        ms_YS60DAXB: MlWorkload.RestorationFaithful,
        ms_F1SSRED6: MlWorkload.RestorationCreative,
      });
    });

    it('never offers a restoration mode the catalogue does not confirm, even if capabilities offers restoration (FL-181 P1)', async () => {
      link();
      const restoration = catalogSchema.parse(restorationFixture);
      mocks.frameleafCloudMl.getCatalog.mockResolvedValue({
        ...restoration,
        models: restoration.models.filter((model) => model.mode !== 'creative'),
      });

      const probe = await sut.probe();

      expect(probe.workloads).toContain(MlWorkload.RestorationFaithful);
      expect(probe.workloads).not.toContain(MlWorkload.RestorationCreative);
    });

    it('never offers a restoration mode whose only model the licence gate refused (FL-183)', async () => {
      link();
      mocks.frameleafCloudMl.getCatalog.mockResolvedValue(
        catalogSchema.parse({
          ...restorationFixture,
          models: [
            ...restorationFixture.models.filter((model) => model.mode !== 'creative'),
            cloudContractFixture('ml/rejected/catalog-entry-non-commercial-licence.json'),
          ],
        }),
      );

      const probe = await sut.probe();

      expect(probe.workloads).toEqual([MlWorkload.Enrichment, MlWorkload.RestorationFaithful]);
      expect(probe.cloud?.modelIds).toEqual(['ms_YS60DAXB']);
    });

    it('reads an expired entitlement as not entitled, so admission refuses it (FL-183)', async () => {
      link();
      mocks.frameleafCloudMl.getCapabilities.mockResolvedValue({
        ...capabilities,
        entitlement: { active: false, state: 'expired', graceUntil: null },
      });

      const probe = await sut.probe();

      expect(probe.cloud?.entitled).toBe(false);
    });

    it('stays entitled during the grace period (capabilities-not-ready.json)', async () => {
      link();
      mocks.frameleafCloudMl.getCapabilities.mockResolvedValue(
        capabilitiesSchema.parse(cloudContractFixture('ml/capabilities-not-ready.json')),
      );

      const probe = await sut.probe();

      expect(probe.cloud).toMatchObject({ entitled: true, consentRecordedVersion: '2026-01-15.1' });
      // an empty capabilities list offers nothing, whatever the catalogue lists
      expect(probe.workloads).toEqual([]);
    });

    it('admits neither restoration mode when the catalogue could not be read (FL-181 P1: never over-admit)', async () => {
      link();
      mocks.frameleafCloudMl.getCatalog.mockRejectedValue(new Error('catalog unavailable'));

      const probe = await sut.probe();

      expect(probe.reachable).toBe(true);
      expect(probe.workloads).toEqual([MlWorkload.Enrichment]);
      expect(probe.cloud?.modelIds).toEqual([]);
    });

    it('keeps the refusal when the gateway answers but refuses (402)', async () => {
      link();
      mocks.frameleafCloudMl.getCapabilities.mockRejectedValue(
        new FrameleafCloudError(MlAdmissionRefusal.WalletInsufficient, 402, 'The AI Wallet is empty'),
      );

      const probe = await sut.probe();

      expect(probe).toMatchObject({ reachable: true, workloads: [], error: 'The AI Wallet is empty' });
      expect(probe.cloud?.refusal).toEqual({
        refusal: MlAdmissionRefusal.WalletInsufficient,
        detail: 'The AI Wallet is empty',
      });
    });

    it('reports an unreachable gateway as unavailable', async () => {
      link();
      mocks.frameleafCloudMl.ping.mockRejectedValue(
        new FrameleafCloudError(MlAdmissionRefusal.CloudUnavailable, null, 'Frameleaf Cloud did not answer'),
      );

      const probe = await sut.probe();

      expect(probe.reachable).toBe(false);
      expect(probe.cloud?.refusal?.refusal).toBe(MlAdmissionRefusal.CloudUnavailable);
    });

    it('reuses a fresh result instead of calling the cloud again', async () => {
      link();
      await sut.probe(10_000);
      await sut.probe(10_000);
      expect(mocks.frameleafCloudMl.getCapabilities).toHaveBeenCalledTimes(1);
    });
  });

  describe('createDestination', () => {
    it('creates the destination with no URL or token, the account region and no consent', async () => {
      link();

      const result = await sut.createDestination({
        name: 'Frameleaf Cloud',
        workloads: [MlWorkload.Enrichment, MlWorkload.RestorationCreative, MlWorkload.Enrichment],
        budgetLimitUsd: 30,
      });

      expect(mocks.mlDestination.create).toHaveBeenCalledWith({
        kind: MlDestinationKind.FrameleafCloud,
        name: 'Frameleaf Cloud',
        url: null,
        authToken: null,
        enabled: true,
        workloads: [MlWorkload.Enrichment, MlWorkload.RestorationCreative],
        budgetLimitUsd: 30,
        maxRuntimeMinutes: null,
        maxUploadBytes: null,
        sharesLibraryHardware: false,
        region: 'eu',
      });
      expect(result).toMatchObject({ url: null, authTokenConfigured: false, consent: { required: true } });
      // Never routed automatically.
      expect(mocks.mlDestination.setRoute).not.toHaveBeenCalled();
    });

    it('refuses faces and local-only work by policy', async () => {
      link();
      await expect(sut.createDestination({ name: 'Cloud', workloads: [MlWorkload.Face] })).rejects.toThrow(
        /stays on this network/,
      );
      expect(mocks.mlDestination.create).not.toHaveBeenCalled();
    });

    it('refuses before the server is configured and linked, and refuses a second destination', async () => {
      configure({ url: null });
      await expect(sut.createDestination({ name: 'Cloud', workloads: [MlWorkload.Enrichment] })).rejects.toThrow(
        /not configured/,
      );
      configure();
      await expect(sut.createDestination({ name: 'Cloud', workloads: [MlWorkload.Enrichment] })).rejects.toThrow(
        /not linked/,
      );
      link();
      mocks.mlDestination.getAll.mockResolvedValue([mlDestinationStub.frameleafCloud]);
      await expect(sut.createDestination({ name: 'Cloud', workloads: [MlWorkload.Enrichment] })).rejects.toThrow(
        /already added/,
      );
      expect(mocks.mlDestination.create).not.toHaveBeenCalled();
    });
  });

  describe('getStatus', () => {
    it('says Frameleaf Cloud is not configured without contacting anything', async () => {
      configure({ url: null });

      await expect(sut.getStatus()).resolves.toMatchObject({
        connection: 'not-configured',
        enabled: true,
        destination: null,
        consent: null,
        wallet: null,
      });
      expect(mocks.frameleafCloud.discovery).not.toHaveBeenCalled();
    });

    it('reports the required consent version, flags an outdated consent and reads the wallet', async () => {
      link();
      mocks.mlDestination.getAll.mockResolvedValue([mlDestinationStub.frameleafCloudConsented]);

      const status = await sut.getStatus();

      expect(status).toMatchObject({
        connection: 'ready',
        region: 'eu',
        entitled: true,
        destination: { id: mlDestinationStub.frameleafCloudConsented.id, url: null },
        consent: { requiredVersion: '2026-10-01.1', acceptedVersion: '2026-09-25', outdated: true },
        wallet: { balanceUsd: 12, heldUsd: 2, availableUsd: 10, topUpUrl: 'https://account.cloud.test/wallet' },
      });
      // A read never writes: settlements are applied by the explicit usage refresh only.
      expect(mocks.frameleafCloudMl.getUsage).not.toHaveBeenCalled();
      expect(mocks.mlDestination.applySettlements).not.toHaveBeenCalled();
    });

    it('shows the top-up link only when the cloud returned one', async () => {
      link();
      mocks.frameleafCloudMl.getWallet.mockResolvedValue({
        balanceUsd: 1,
        heldUsd: 0,
        dailyCapUsd: null,
        spentTodayUsd: 0,
        topUpUrl: null,
        settingsUrl: null,
        autoTopUp: false,
      });

      await expect(sut.getStatus()).resolves.toMatchObject({ wallet: { topUpUrl: null } });
    });
  });

  describe('catalogue, wallet and usage', () => {
    it('lists the models the cloud offers by SKU and revision (never the local-only or refused ones)', async () => {
      link();
      const result = await sut.getCatalog();

      // FL-183: `id` is the model SKU, `fingerprint` its revision, `name` the label; prices are per second
      expect(result.models.map((model) => model.id)).toEqual([
        'ms_K6WT70CS',
        'ms_M7QG26PT',
        'ms_54S55W7C',
        'ms_YS60DAXB',
      ]);
      expect(result.models[1]).toEqual({
        id: 'ms_M7QG26PT',
        workload: MlWorkload.Enrichment,
        name: 'Descriptions · Best (fallback)',
        description: 'Qwen2.5-VL-72B AWQ, H200-class, 141 GB. Built with Qwen',
        fingerprint: 'mr_68JDMAM8444M',
        pricingUnit: 'second',
        priceUsd: 0.004_583,
      });
      expect(result.models[3]).toMatchObject({
        id: 'ms_YS60DAXB',
        workload: MlWorkload.RestorationFaithful,
        description: 'RealBasicVSR, L40S-class, 48 GB',
        fingerprint: 'mr_4H8QZ2N7C1TX',
      });
    });

    it('assigns each restoration model of catalog-restoration.json to the app workload its own mode names (FL-181)', async () => {
      link();
      mocks.frameleafCloudMl.getCatalog.mockResolvedValue(
        catalogSchema.parse({
          ...restorationFixture,
          // the cloud never publishes a restoration model without a mode; the contract refuses one
          models: [
            ...restorationFixture.models,
            cloudContractFixture('ml/rejected/catalog-entry-restoration-without-mode.json'),
          ],
        }),
      );

      const result = await sut.getCatalog();

      expect(result.models.map((model) => [model.id, model.workload])).toEqual([
        ['ms_YS60DAXB', MlWorkload.RestorationFaithful],
        ['ms_F1SSRED6', MlWorkload.RestorationCreative],
      ]);
    });

    it('refuses the wallet while the server is not linked', async () => {
      await expect(sut.getWallet()).rejects.toBeInstanceOf(BadRequestException);
    });

    it('applies the settlements of usage.json to the accounting rows of their jobs', async () => {
      link();
      mocks.frameleafCloudMl.getUsage.mockResolvedValue(usageSchema.parse(cloudContractFixture('ml/usage.json')));
      mocks.mlDestination.applySettlements.mockResolvedValue(1);

      await expect(sut.reconcileUsage()).resolves.toEqual({ settled: 1 });
      expect(mocks.mlDestination.applySettlements).toHaveBeenCalledWith([
        { cloudJobId: '0192f1b0-1a2b-7c3d-8e4f-5a6b7c8d9e0f', costUsd: 0.0244, credits: null },
      ]);
    });

    it('applies nothing when the cloud refuses to answer the usage report as the contract says', async () => {
      link();
      mocks.frameleafCloudMl.getUsage.mockRejectedValue(
        new FrameleafCloudError(
          MlAdmissionRefusal.CloudUnavailable,
          200,
          'Frameleaf Cloud sent a response this server does not understand',
        ),
      );

      await expect(sut.reconcileUsage()).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.mlDestination.applySettlements).not.toHaveBeenCalled();
    });
  });

  describe('updateWallet', () => {
    it('changes the daily cap and automatic top-up on the account and caches the answer', async () => {
      link();
      mocks.frameleafCloudMl.updateWallet.mockResolvedValue({
        balanceUsd: 12,
        heldUsd: 2,
        dailyCapUsd: 40,
        spentTodayUsd: 0,
        topUpUrl: null,
        autoTopUp: true,
        settingsUrl: null,
      });

      await expect(sut.updateWallet({ dailyCapUsd: 40, autoTopUp: true })).resolves.toMatchObject({
        dailyCapUsd: 40,
        autoTopUp: true,
        availableUsd: 10,
      });
      expect(mocks.frameleafCloudMl.updateWallet).toHaveBeenCalledWith(expect.anything(), {
        dailyCapUsd: 40,
        autoTopUp: true,
      });
      expect(metadata.get(SystemMetadataKey.FrameleafMlWallet)).toMatchObject({ dailyCapUsd: 40, autoTopUp: true });
    });

    it('refuses an empty change and refuses while the server is not linked', async () => {
      link();
      await expect(sut.updateWallet({})).rejects.toBeInstanceOf(BadRequestException);
      metadata.clear();
      await expect(sut.updateWallet({ autoTopUp: true })).rejects.toBeInstanceOf(BadRequestException);
    });

    describe('an increase the account owner has to confirm (FL-177, as-built decision #22)', () => {
      const stepUp = (url: string) =>
        new FrameleafCloudError(MlAdmissionRefusal.ConsentMissing, 403, 'Confirm this in your account.', {
          code: 'step-up-required',
          message: 'Confirm this in your account.',
          retryable: false,
          refusal: null,
          detail: null,
          data: { url },
          requestId: 'req_01J8ZK3M4N5P6Q7R',
        });

      it('answers 403 and keeps the account-app page the cloud named for the wallet links', async () => {
        link();
        await sut.getWallet();
        mocks.frameleafCloudMl.updateWallet.mockRejectedValue(stepUp('https://account.cloud.test/wallet/settings'));

        await expect(sut.updateWallet({ dailyCapUsd: 200 })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(sut.updateWallet({ autoTopUp: true })).rejects.toThrow(WALLET_STEP_UP_MESSAGE);
        await expect(sut.updateWallet({ autoTopUp: true })).rejects.toMatchObject({
          response: { code: 'step-up-required', statusCode: 403 },
        });
        expect(metadata.get(SystemMetadataKey.FrameleafMlWallet)).toMatchObject({
          settingsUrl: 'https://account.cloud.test/wallet/settings',
        });
        // a later read without the address keeps it
        await expect(sut.getWallet()).resolves.toMatchObject({
          settingsUrl: 'https://account.cloud.test/wallet/settings',
        });
      });

      it('never keeps an account address outside the configured cloud', async () => {
        link();
        await sut.getWallet();
        mocks.frameleafCloudMl.updateWallet.mockRejectedValue(stepUp('https://account.attacker.example/wallet'));
        await expect(sut.updateWallet({ dailyCapUsd: 200 })).rejects.toBeInstanceOf(ForbiddenException);
        expect(metadata.get(SystemMetadataKey.FrameleafMlWallet)).toMatchObject({ settingsUrl: null });

        mocks.frameleafCloudMl.getWallet.mockResolvedValue({
          balanceUsd: 12,
          heldUsd: 2,
          dailyCapUsd: null,
          spentTodayUsd: 0,
          topUpUrl: null,
          autoTopUp: false,
          settingsUrl: 'https://account.attacker.example/wallet',
        });
        await expect(sut.getWallet()).resolves.toMatchObject({ settingsUrl: null });
      });

      it('reads the account-app page from the wallet when the cloud names it there', async () => {
        link();
        mocks.frameleafCloudMl.getWallet.mockResolvedValue({
          balanceUsd: 12,
          heldUsd: 2,
          dailyCapUsd: 20,
          spentTodayUsd: 0,
          topUpUrl: null,
          autoTopUp: false,
          settingsUrl: 'https://account.cloud.test/wallet/settings',
        });
        await expect(sut.getWallet()).resolves.toMatchObject({
          settingsUrl: 'https://account.cloud.test/wallet/settings',
        });
      });

      it('passes any other refusal on as before', async () => {
        link();
        mocks.frameleafCloudMl.updateWallet.mockRejectedValue(
          new FrameleafCloudError(MlAdmissionRefusal.CloudUnavailable, 503, 'Frameleaf Cloud did not answer'),
        );
        await expect(sut.updateWallet({ dailyCapUsd: 5 })).rejects.toBeInstanceOf(BadRequestException);
      });
    });
  });

  describe('getSettlements', () => {
    it('lists nothing before the destination is added', async () => {
      await expect(sut.getSettlements()).resolves.toEqual({ items: [] });
      expect(mocks.mlDestination.getSettlements).not.toHaveBeenCalled();
    });

    it("lists the destination's settled charges without contacting the cloud", async () => {
      mocks.mlDestination.getAll.mockResolvedValue([mlDestinationStub.local, mlDestinationStub.frameleafCloud]);
      mocks.mlDestination.getSettlements.mockResolvedValue([
        {
          cloudJobId: 'job-1',
          workload: MlWorkload.Enrichment,
          jobName: 'ImageDescription',
          outcome: 'success',
          costUsd: 0.42,
          credits: 42,
          startedAt: new Date('2026-09-25T09:59:00Z'),
          finishedAt: new Date('2026-09-25T10:00:00Z'),
        },
      ] as never);

      await expect(sut.getSettlements()).resolves.toEqual({
        items: [
          {
            cloudJobId: 'job-1',
            workload: MlWorkload.Enrichment,
            jobName: 'ImageDescription',
            succeeded: true,
            costUsd: 0.42,
            credits: 42,
            finishedAt: '2026-09-25T10:00:00.000Z',
            modelSku: null,
            computeSku: null,
            gpuSeconds: null,
            workers: null,
            estimateUsd: null,
          },
        ],
      });
      expect(mocks.mlDestination.getSettlements).toHaveBeenCalledWith(mlDestinationStub.frameleafCloud.id, 50);
      // Not linked: the local rows stand on their own and nothing is asked of the cloud.
      expect(mocks.frameleafCloudMl.getUsage).not.toHaveBeenCalled();

      link();
      mocks.frameleafCloudMl.getUsage.mockResolvedValue({
        items: [
          {
            jobId: 'job-1',
            clientRef: null,
            settledUsd: 0.42,
            credits: 42,
            settledAt: '2026-09-25T10:00:00Z',
            modelSku: 'ms_01J8ZK3M4N5P6Q7R',
            computeSku: 'cs_01J8ZK3M4N5P6Q7R',
            gpuSeconds: 312,
            workers: 1,
            estimateUsd: 0.5,
          },
        ],
      });
      await expect(sut.getSettlements()).resolves.toMatchObject({
        items: [
          {
            cloudJobId: 'job-1',
            modelSku: 'ms_01J8ZK3M4N5P6Q7R',
            computeSku: 'cs_01J8ZK3M4N5P6Q7R',
            gpuSeconds: 312,
            workers: 1,
            estimateUsd: 0.5,
          },
        ],
      });
    });
  });

  describe('bootstrap', () => {
    it('registers the cloud check and tells every administrator once about removed destinations', async () => {
      (mocks.config.getWorker as ReturnType<typeof vi.fn>).mockReturnValue(ImmichWorker.Api);
      metadata.set(SystemMetadataKey.FrameleafCloudMigrationNotice, {
        removedDestinations: [{ name: 'Cloud GPU', workloads: ['enrichment'] }],
        cancelledOperations: 2,
        revokedRenderWorkers: 1,
        createdAt: '2026-09-25T00:00:00.000Z',
      });
      mocks.user.getList.mockResolvedValue([
        { id: 'admin-1', isAdmin: true, deletedAt: null },
        { id: 'user-1', isAdmin: false, deletedAt: null },
        { id: 'admin-2', isAdmin: true, deletedAt: null },
      ] as never);
      mocks.notification.create.mockResolvedValue({} as never);

      await sut.onBootstrap();

      expect(mocks.machineLearning.setCloudProber).toHaveBeenCalledWith(expect.any(Function));
      expect(mocks.notification.create).toHaveBeenCalledTimes(2);
      const [notice] = mocks.notification.create.mock.calls[0];
      expect(notice).toMatchObject({
        userId: 'admin-1',
        type: NotificationType.SystemMessage,
        level: NotificationLevel.Warning,
        title: 'Cloud processing moved to Frameleaf Cloud',
      });
      expect(notice.description).toContain('Cloud GPU was removed');
      expect(notice.description).toContain('not sent anywhere else');
      expect(notice.description).toContain('2 unfinished jobs stopped');
      expect(notice.description).not.toMatch(/runpod/i);
      expect(metadata.has(SystemMetadataKey.FrameleafCloudMigrationNotice)).toBe(false);
    });

    it('sends nothing when there is no notice or on another worker', async () => {
      (mocks.config.getWorker as ReturnType<typeof vi.fn>).mockReturnValue(ImmichWorker.Microservices);
      metadata.set(SystemMetadataKey.FrameleafCloudMigrationNotice, {
        removedDestinations: [],
        cancelledOperations: 1,
        createdAt: '2026-09-25T00:00:00.000Z',
      });
      await sut.onBootstrap();
      (mocks.config.getWorker as ReturnType<typeof vi.fn>).mockReturnValue(ImmichWorker.Api);
      metadata.delete(SystemMetadataKey.FrameleafCloudMigrationNotice);
      await sut.onBootstrap();

      expect(mocks.notification.create).not.toHaveBeenCalled();
    });
  });
});
