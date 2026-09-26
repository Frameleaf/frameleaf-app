import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRenderWorker } from 'src/repositories/render-worker.repository.js';
import { defaults } from 'src/config.js';
import { AssetRestorationMode } from 'src/dtos/asset-restoration.dto.js';
import {
  RESTORATION_PROTOCOL,
  RestorationDynamicRange,
  RestorationModelState,
} from 'src/dtos/restoration-inference.dto.js';
import {
  ImmichWorker,
  MediaOperationKind,
  MlAdmissionRefusal,
  MlDestinationHealth,
  MlDestinationKind,
  MlWorkload,
  RenderWorkerStatus,
  SystemMetadataKey,
} from 'src/enum.js';
import { FRAMELEAF_CLOUD_ENDPOINT } from 'src/repositories/machine-learning.repository.js';
import { ML_URL_REMOVED_SUMMARY, MlDestinationService } from 'src/services/ml-destination.service.js';
import { FrameleafCloudError, errorEnvelopeSchema } from 'src/utils/frameleaf-cloud.js';
import { MlDestinationRefusedError } from 'src/utils/ml-destination.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';
import { mlDestinationStub, mlProbeStub } from 'test/fixtures/ml-destination.stub.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

/** The identity key's signer (FL-178): the key the ML token is bound to and every proof is signed with. */
const identitySigner = {
  kid: 'kid-1',
  publicJwk: { kty: 'OKP' as const, crv: 'Ed25519' as const, x: 'x' },
  sign: () => 'header.payload.signature',
};

describe(MlDestinationService.name, () => {
  let sut: MlDestinationService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(MlDestinationService));
    mocks.mlDestination.getAll.mockResolvedValue([mlDestinationStub.local, mlDestinationStub.frameleafCloud]);
    mocks.mlDestination.getRoutes.mockResolvedValue([
      { workload: MlWorkload.Face, destinationId: mlDestinationStub.local.id, modelId: null, updatedAt: new Date() },
    ]);
    mocks.mlDestination.getThroughput.mockResolvedValue({ sampleCount: 0, bytesSent: 0, durationMs: 0, spentUsd: 0 });
    // Like the database, an update leaves a column alone when the patch leaves it undefined.
    mocks.mlDestination.update.mockImplementation((id, patch) =>
      Promise.resolve({
        ...(id === mlDestinationStub.frameleafCloud.id ? mlDestinationStub.frameleafCloud : mlDestinationStub.local),
        ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
      } as never),
    );
    mocks.mlDestination.setRoute.mockResolvedValue();
    mocks.mlDestination.clearRoute.mockResolvedValue();
    mocks.mlDestination.getCloudModelChoices.mockResolvedValue([]);
    mocks.mlDestination.create.mockImplementation((row) =>
      Promise.resolve({ ...mlDestinationStub.local, ...row, id: 'created' } as never),
    );
    mocks.renderWorker.listLiveSessions.mockResolvedValue([]);
  });

  describe('bootstrap', () => {
    it('creates a local destination for each configured ML URL and routes unrouted library workloads to the first', async () => {
      mocks.mlDestination.getByUrl.mockResolvedValue(undefined);
      mocks.mlDestination.getRoute.mockResolvedValue(undefined);
      (mocks.config.getWorker as ReturnType<typeof vi.fn>).mockReturnValue(ImmichWorker.Microservices);

      await sut.onConfigInit({
        newConfig: {
          ...defaults,
          machineLearning: {
            ...defaults.machineLearning,
            urls: ['http://immich-machine-learning:3003'],
            availabilityChecks: { ...defaults.machineLearning.availabilityChecks, enabled: false },
          },
        },
      } as never);

      expect(mocks.mlDestination.create).toHaveBeenCalledTimes(1);
      expect(mocks.mlDestination.create).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: MlDestinationKind.Local,
          url: 'http://immich-machine-learning:3003',
          workloads: [
            MlWorkload.Face,
            MlWorkload.Clip,
            MlWorkload.Ocr,
            MlWorkload.Enrichment,
            MlWorkload.PetRecognition,
          ],
        }),
      );
      expect(mocks.mlDestination.setRoute).toHaveBeenCalledTimes(5);
      for (const workload of [
        MlWorkload.Face,
        MlWorkload.Clip,
        MlWorkload.Ocr,
        MlWorkload.Enrichment,
        MlWorkload.PetRecognition,
      ]) {
        expect(mocks.mlDestination.setRoute).toHaveBeenCalledWith(workload, 'created');
      }
    });

    it('allows pet recognition on this server’s existing local destination as it routes it there (FL-58)', async () => {
      mocks.mlDestination.getByUrl.mockResolvedValue(mlDestinationStub.local);
      mocks.mlDestination.getRoute.mockImplementation((workload) =>
        Promise.resolve(
          workload === MlWorkload.PetRecognition
            ? undefined
            : { workload, destinationId: mlDestinationStub.local.id, modelId: null, updatedAt: new Date() },
        ),
      );
      (mocks.config.getWorker as ReturnType<typeof vi.fn>).mockReturnValue(ImmichWorker.Microservices);

      await sut.onConfigInit({
        newConfig: {
          ...defaults,
          machineLearning: {
            ...defaults.machineLearning,
            availabilityChecks: { ...defaults.machineLearning.availabilityChecks, enabled: false },
          },
        },
      } as never);

      expect(mocks.mlDestination.update).toHaveBeenCalledWith(mlDestinationStub.local.id, {
        workloads: [...mlDestinationStub.local.workloads, MlWorkload.PetRecognition],
      });
      expect(mocks.mlDestination.setRoute).toHaveBeenCalledTimes(1);
      expect(mocks.mlDestination.setRoute).toHaveBeenCalledWith(MlWorkload.PetRecognition, mlDestinationStub.local.id);
    });

    it('never creates a cloud destination or routes restoration and Studio work on its own', async () => {
      mocks.mlDestination.getByUrl.mockResolvedValue(mlDestinationStub.local);
      mocks.mlDestination.getRoute.mockResolvedValue(undefined);
      (mocks.config.getWorker as ReturnType<typeof vi.fn>).mockReturnValue(ImmichWorker.Microservices);

      await sut.onConfigInit({
        newConfig: {
          ...defaults,
          machineLearning: {
            ...defaults.machineLearning,
            availabilityChecks: { ...defaults.machineLearning.availabilityChecks, enabled: false },
          },
        },
      } as never);

      expect(mocks.mlDestination.create).not.toHaveBeenCalled();
      const routed = mocks.mlDestination.setRoute.mock.calls.map(([workload]) => workload);
      expect(routed).not.toContain(MlWorkload.RestorationFaithful);
      expect(routed).not.toContain(MlWorkload.RestorationCreative);
      expect(routed).not.toContain(MlWorkload.StudioAi);
    });

    const bootWith = (urls: string[]) =>
      sut.onConfigInit({
        newConfig: {
          ...defaults,
          machineLearning: {
            ...defaults.machineLearning,
            urls,
            availabilityChecks: { ...defaults.machineLearning.availabilityChecks, enabled: false },
          },
        },
      } as never);

    it('turns off the local destination whose URL left the list, keeping its routes so work is refused (FL-72)', async () => {
      const second = { ...mlDestinationStub.local, id: 'ml-destination-second', url: 'http://second:3003' };
      mocks.mlDestination.getAll.mockResolvedValue([mlDestinationStub.local, second, mlDestinationStub.lan]);
      mocks.mlDestination.getByUrl.mockResolvedValue(mlDestinationStub.local);
      mocks.mlDestination.getRoute.mockResolvedValue({
        workload: MlWorkload.Face,
        destinationId: second.id,
        modelId: null,
        updatedAt: new Date(),
      });
      (mocks.config.getWorker as ReturnType<typeof vi.fn>).mockReturnValue(ImmichWorker.Microservices);

      await bootWith(['http://immich-machine-learning:3003']);

      expect(mocks.mlDestination.update).toHaveBeenCalledTimes(1);
      expect(mocks.mlDestination.update).toHaveBeenCalledWith(second.id, { enabled: false });
      expect(mocks.mlDestination.recordProbe).toHaveBeenCalledWith(
        second.id,
        expect.objectContaining({ summary: ML_URL_REMOVED_SUMMARY, health: MlDestinationHealth.Unhealthy }),
      );
      // Routes are never rewritten to another endpoint.
      expect(mocks.mlDestination.setRoute).not.toHaveBeenCalled();
      expect(mocks.mlDestination.clearRoute).not.toHaveBeenCalled();
    });

    it('turns a destination back on when its URL returns, but not one an administrator turned off', async () => {
      const removed = { ...mlDestinationStub.local, enabled: false, lastProbeSummary: ML_URL_REMOVED_SUMMARY };
      mocks.mlDestination.getAll.mockResolvedValue([removed]);
      mocks.mlDestination.getByUrl.mockResolvedValue(removed);
      mocks.mlDestination.getRoute.mockResolvedValue({
        workload: MlWorkload.Face,
        destinationId: removed.id,
        modelId: null,
        updatedAt: new Date(),
      });
      (mocks.config.getWorker as ReturnType<typeof vi.fn>).mockReturnValue(ImmichWorker.Microservices);

      await bootWith(['http://immich-machine-learning:3003']);
      expect(mocks.mlDestination.update).toHaveBeenCalledWith(removed.id, { enabled: true });

      vi.clearAllMocks();
      const adminOff = { ...mlDestinationStub.local, enabled: false, lastProbeSummary: 'Serves face' };
      mocks.mlDestination.getAll.mockResolvedValue([adminOff]);
      mocks.mlDestination.getByUrl.mockResolvedValue(adminOff);
      mocks.mlDestination.getRoute.mockResolvedValue({
        workload: MlWorkload.Face,
        destinationId: adminOff.id,
        modelId: null,
        updatedAt: new Date(),
      });

      await bootWith(['http://immich-machine-learning:3003']);
      expect(mocks.mlDestination.update).not.toHaveBeenCalled();
    });

    it('leaves existing routes alone', async () => {
      mocks.mlDestination.getByUrl.mockResolvedValue(mlDestinationStub.local);
      mocks.mlDestination.getRoute.mockResolvedValue({
        workload: MlWorkload.Face,
        destinationId: 'ml-destination-lan',
        modelId: null,
        updatedAt: new Date(),
      });
      (mocks.config.getWorker as ReturnType<typeof vi.fn>).mockReturnValue(ImmichWorker.Microservices);

      await sut.onConfigInit({
        newConfig: {
          ...defaults,
          machineLearning: {
            ...defaults.machineLearning,
            availabilityChecks: { ...defaults.machineLearning.availabilityChecks, enabled: false },
          },
        },
      } as never);

      expect(mocks.mlDestination.setRoute).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('never creates Frameleaf Cloud here: only its own endpoint does (FL-159)', async () => {
      await expect(
        sut.create({
          kind: MlDestinationKind.FrameleafCloud,
          name: 'Frameleaf Cloud',
          workloads: [MlWorkload.Enrichment],
          enabled: true,
        }),
      ).rejects.toThrow(/its own settings section/);
      expect(mocks.mlDestination.create).not.toHaveBeenCalled();
    });

    it('refuses a URL or token on Frameleaf Cloud (FL-159)', async () => {
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.frameleafCloud);
      await expect(
        sut.update(mlDestinationStub.frameleafCloud.id, { url: 'https://elsewhere.example', authToken: 'x' }),
      ).rejects.toThrow(/takes no URL or credential/);
    });

    it('requires a URL for a LAN destination', async () => {
      await expect(
        sut.create({ kind: MlDestinationKind.Lan, name: 'Workshop', workloads: [], enabled: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates a LAN destination without consent fields and never returns the token', async () => {
      mocks.mlDestination.create.mockResolvedValue({ ...mlDestinationStub.lan, id: 'created' });

      const result = await sut.create({
        kind: MlDestinationKind.Lan,
        name: 'Workshop GPU',
        url: 'https://workshop.lan:3003',
        authToken: 'lan-token',
        workloads: [MlWorkload.Face, MlWorkload.Face],
        enabled: true,
      });

      expect(mocks.mlDestination.create).toHaveBeenCalledWith(
        expect.objectContaining({ authToken: 'lan-token', workloads: [MlWorkload.Face] }),
      );
      expect(result.authTokenConfigured).toBe(true);
      expect(JSON.stringify(result)).not.toContain('lan-token');
      expect(result.consent.required).toBe(false);
    });
  });

  describe('consent', () => {
    const linkCloud = () => {
      mocks.config.getEnv.mockReturnValue({
        ...mocks.config.getEnv(),
        frameleafCloud: {
          ...mocks.config.getEnv().frameleafCloud,
          url: 'https://cloud.test',
          identityDir: '/tmp/identity',
        },
      });
      mocks.systemMetadata.get.mockImplementation((key) =>
        Promise.resolve(
          (key === SystemMetadataKey.FrameleafCloudLink
            ? { status: 'linked', cloudUrl: 'https://cloud.test', instanceId: 'instance-1', dataRegion: 'eu' }
            : null) as never,
        ),
      );
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
        validFor: 86_400,
        issuer: 'https://id.cloud.test',
        api: 'https://api.cloud.test',
        ml: { eu: 'https://ml.eu.cloud.test' },
      });
      mocks.instanceIdentity.currentSigner.mockReturnValue(identitySigner);
      mocks.frameleafCloud.accessToken.mockResolvedValue({ accessToken: 'instance-token', signer: identitySigner });
      mocks.frameleafCloudMl.getConsent.mockResolvedValue({
        requiredVersion: '2026-09-25',
        recordedVersion: null,
        recordedAt: null,
        features: { identityNames: false, medicalSignals: false, ocrAddon: false },
        summary: '',
        textSha256: null,
        documentUrl: null,
      });
      mocks.frameleafCloudMl.recordConsent.mockResolvedValue({
        recordedVersion: '2026-09-25',
        recordedAt: '2026-09-25T04:00:00.000Z',
        features: { identityNames: false, medicalSignals: false, ocrAddon: false },
      });
      mocks.frameleafConsent.record.mockResolvedValue({} as never);
    };

    it('records versioned Frameleaf Cloud consent with Frameleaf Cloud, the fork table and the destination (FL-159)', async () => {
      linkCloud();
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.frameleafCloud);

      const result = await sut.grantConsent(authStub.admin, mlDestinationStub.frameleafCloud.id, {
        acknowledgeMediaLeavesNetwork: true,
        version: '2026-09-25',
        features: { identityNames: false, medicalSignals: true, ocrAddon: false },
      });

      const gateway = {
        url: 'https://ml.eu.cloud.test',
        token: { accessToken: 'instance-token', signer: identitySigner },
        onCloneSuspected: expect.any(Function),
      };
      expect(mocks.frameleafCloud.accessToken).toHaveBeenCalledWith(
        expect.objectContaining({ issuer: 'https://id.cloud.test' }),
        'instance-1',
        'https://ml.eu.cloud.test',
        identitySigner,
      );
      expect(mocks.frameleafCloudMl.recordConsent).toHaveBeenCalledWith(gateway, {
        version: '2026-09-25',
        features: { identityNames: false, medicalSignals: true, ocrAddon: false },
      });
      expect(mocks.frameleafConsent.record).toHaveBeenCalledWith({
        destinationId: mlDestinationStub.frameleafCloud.id,
        version: '2026-09-25',
        features: { identityNames: false, medicalSignals: true, ocrAddon: false },
        acceptedBy: authStub.admin.user.id,
        cloudRecordedVersion: '2026-09-25',
      });
      expect(mocks.mlDestination.update).toHaveBeenCalledWith(mlDestinationStub.frameleafCloud.id, {
        consentAcknowledgedAt: expect.any(Date),
        consentAcknowledgedBy: authStub.admin.user.id,
        consentVersion: '2026-09-25',
      });
      expect(result.consent.acknowledgedBy).toBe(authStub.admin.user.id);
    });

    it('refuses Frameleaf Cloud consent to an outdated version and records nothing (FL-159)', async () => {
      linkCloud();
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.frameleafCloud);

      await expect(
        sut.grantConsent(authStub.admin, mlDestinationStub.frameleafCloud.id, {
          acknowledgeMediaLeavesNetwork: true,
          version: '2026-01-01',
        }),
      ).rejects.toThrow(/now asks for consent version 2026-09-25/);
      expect(mocks.frameleafCloudMl.recordConsent).not.toHaveBeenCalled();
      expect(mocks.frameleafConsent.record).not.toHaveBeenCalled();
      expect(mocks.mlDestination.update).not.toHaveBeenCalled();
    });

    it('names the version now required when the disclosure changed before the cloud recorded it, and records nothing (FL-183)', async () => {
      linkCloud();
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.frameleafCloud);
      const envelope = errorEnvelopeSchema.parse(cloudContractFixture('errors/consent-version-outdated.json'));
      mocks.frameleafCloudMl.recordConsent.mockRejectedValue(
        new FrameleafCloudError(MlAdmissionRefusal.ConsentVersionOutdated, 403, envelope.message, envelope),
      );

      await expect(
        sut.grantConsent(authStub.admin, mlDestinationStub.frameleafCloud.id, {
          acknowledgeMediaLeavesNetwork: true,
          version: '2026-09-25',
        }),
      ).rejects.toThrow('Frameleaf Cloud now asks for consent version 2026-09-26.1; review it and accept again');
      expect(mocks.frameleafConsent.record).not.toHaveBeenCalled();
      expect(mocks.mlDestination.update).not.toHaveBeenCalled();
    });

    it('refuses Frameleaf Cloud consent without a version, or while the server is not linked (FL-159)', async () => {
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.frameleafCloud);
      await expect(
        sut.grantConsent(authStub.admin, mlDestinationStub.frameleafCloud.id, { acknowledgeMediaLeavesNetwork: true }),
      ).rejects.toThrow(/names the version/);
      await expect(
        sut.grantConsent(authStub.admin, mlDestinationStub.frameleafCloud.id, {
          acknowledgeMediaLeavesNetwork: true,
          version: '2026-09-25',
        }),
      ).rejects.toThrow(/not configured/);
      expect(mocks.frameleafCloud.discovery).not.toHaveBeenCalled();
      expect(mocks.mlDestination.update).not.toHaveBeenCalled();
    });

    it('refuses consent on a destination that keeps media on the network', async () => {
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.local);
      await expect(
        sut.grantConsent(authStub.admin, mlDestinationStub.local.id, { acknowledgeMediaLeavesNetwork: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a consent body that is not the literal acknowledgement', async () => {
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.frameleafCloud);
      await expect(
        sut.grantConsent(authStub.admin, mlDestinationStub.frameleafCloud.id, {
          acknowledgeMediaLeavesNetwork: false,
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.mlDestination.update).not.toHaveBeenCalled();
    });

    it('withdraws Frameleaf Cloud consent here in one step, then with the cloud (FL-159)', async () => {
      linkCloud();
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.frameleafCloudConsented);
      await sut.revokeConsent(mlDestinationStub.frameleafCloudConsented.id);
      // The consent records and the destination are cleared together by the repository, first.
      expect(mocks.frameleafConsent.revoke).toHaveBeenCalledWith(mlDestinationStub.frameleafCloudConsented.id);
      expect(mocks.frameleafConsent.revoke.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.frameleafCloudMl.revokeConsent.mock.invocationCallOrder[0],
      );
      expect(mocks.frameleafCloudMl.revokeConsent).toHaveBeenCalledWith({
        url: 'https://ml.eu.cloud.test',
        token: { accessToken: 'instance-token', signer: identitySigner },
        onCloneSuspected: expect.any(Function),
      });
      expect(mocks.mlDestination.update).not.toHaveBeenCalled();
    });

    it('keeps the withdrawal when Frameleaf Cloud does not answer, and logs it (FL-159)', async () => {
      linkCloud();
      mocks.frameleafCloudMl.revokeConsent.mockRejectedValue(
        new FrameleafCloudError(MlAdmissionRefusal.CloudUnavailable, null, 'offline'),
      );
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.frameleafCloudConsented);
      await expect(sut.revokeConsent(mlDestinationStub.frameleafCloudConsented.id)).resolves.toBeDefined();
      expect(mocks.frameleafConsent.revoke).toHaveBeenCalledWith(mlDestinationStub.frameleafCloudConsented.id);
    });

    it('keeps the withdrawal when reaching Frameleaf Cloud fails in any other way (FL-159)', async () => {
      linkCloud();
      mocks.frameleafCloud.discovery.mockRejectedValue(new TypeError('socket hang up'));
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.frameleafCloudConsented);
      await expect(sut.revokeConsent(mlDestinationStub.frameleafCloudConsented.id)).resolves.toBeDefined();
      expect(mocks.frameleafConsent.revoke).toHaveBeenCalledWith(mlDestinationStub.frameleafCloudConsented.id);
      expect(mocks.frameleafCloudMl.revokeConsent).not.toHaveBeenCalled();
    });

    it('refuses to withdraw consent during a handoff with 409, before contacting Frameleaf Cloud (FL-159)', async () => {
      linkCloud();
      mocks.frameleafConsent.revoke.mockRejectedValue(
        new ConflictException('Consent cannot be withdrawn while the server is being handed over'),
      );
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.frameleafCloudConsented);
      await expect(sut.revokeConsent(mlDestinationStub.frameleafCloudConsented.id)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(mocks.frameleafCloudMl.revokeConsent).not.toHaveBeenCalled();
    });
  });

  describe('setRoute', () => {
    it('refuses routing to a cloud destination without consent', async () => {
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.frameleafCloud);
      await expect(
        sut.setRoute(MlWorkload.Enrichment, { destinationId: mlDestinationStub.frameleafCloud.id }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.mlDestination.setRoute).not.toHaveBeenCalled();
    });

    it('refuses routing a workload the destination does not allow', async () => {
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.local);
      await expect(
        sut.setRoute(MlWorkload.RestorationFaithful, { destinationId: mlDestinationStub.local.id }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('routes to a consented cloud destination and removes a route with null', async () => {
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.frameleafCloudConsented);
      await sut.setRoute(MlWorkload.Enrichment, { destinationId: mlDestinationStub.frameleafCloudConsented.id });
      expect(mocks.mlDestination.setRoute).toHaveBeenCalledWith(
        MlWorkload.Enrichment,
        mlDestinationStub.frameleafCloudConsented.id,
      );

      await sut.setRoute(MlWorkload.Enrichment, { destinationId: null });
      expect(mocks.mlDestination.clearRoute).toHaveBeenCalledWith(MlWorkload.Enrichment);
    });

    it('moves a route without touching the chosen Frameleaf Cloud model (FL-186)', async () => {
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.frameleafCloudConsented);
      await sut.setRoute(MlWorkload.Enrichment, { destinationId: mlDestinationStub.frameleafCloudConsented.id });
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.local);
      await sut.setRoute(MlWorkload.Enrichment, { destinationId: mlDestinationStub.local.id });

      expect(mocks.mlDestination.setRoute).toHaveBeenLastCalledWith(MlWorkload.Enrichment, mlDestinationStub.local.id);
      // the model choice lives apart from the route: moving the route never reads, sets or clears it
      expect(mocks.mlDestination.getCloudModelChoice).not.toHaveBeenCalled();
      expect(mocks.mlDestination.setCloudModelChoice).not.toHaveBeenCalled();
      expect(mocks.mlDestination.clearCloudModelChoice).not.toHaveBeenCalled();
    });

    it('lists every workload, unrouted ones with a null destination', async () => {
      const { routes } = await sut.getRoutes();
      expect(routes).toHaveLength(Object.values(MlWorkload).length);
      expect(routes.find((route) => route.workload === MlWorkload.Face)?.destinationId).toBe(
        mlDestinationStub.local.id,
      );
      expect(routes.find((route) => route.workload === MlWorkload.StudioAi)?.destinationId).toBeNull();
    });
  });

  describe('probe', () => {
    it('records an unresolved local destination as unhealthy without touching the network', async () => {
      mocks.mlDestination.getById.mockResolvedValue({ ...mlDestinationStub.lan, url: null });

      const result = await sut.probe(mlDestinationStub.lan.id);

      expect(result.status).toBe(MlDestinationHealth.Unhealthy);
      expect(mocks.machineLearning.probe).not.toHaveBeenCalled();
      expect(mocks.mlDestination.recordProbe).toHaveBeenCalledWith(
        mlDestinationStub.lan.id,
        expect.objectContaining({ health: MlDestinationHealth.Unhealthy, workloads: null }),
      );
    });

    it('checks Frameleaf Cloud through its delegated check and keeps the cloud facts (FL-159)', async () => {
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.frameleafCloudConsented);
      mocks.machineLearning.probe.mockResolvedValue(mlProbeStub.frameleafCloud);

      const result = await sut.probe(mlDestinationStub.frameleafCloudConsented.id);

      expect(result.status).toBe(MlDestinationHealth.Healthy);
      expect(mocks.machineLearning.probe).toHaveBeenCalledWith(FRAMELEAF_CLOUD_ENDPOINT);
      expect(mocks.machineLearning.getRestorationModels).not.toHaveBeenCalled();
      expect(mocks.mlDestination.recordProbe).toHaveBeenCalledWith(
        mlDestinationStub.frameleafCloudConsented.id,
        expect.objectContaining({ cloud: mlProbeStub.frameleafCloud.cloud }),
      );
    });

    it('probes a LAN destination with its token and persists the served workloads', async () => {
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.lan);
      mocks.machineLearning.probe.mockResolvedValue(mlProbeStub.restoration);
      mocks.machineLearning.getRestorationModels.mockRejectedValue(new Error('offline'));

      const result = await sut.probe(mlDestinationStub.lan.id);

      expect(mocks.machineLearning.probe).toHaveBeenCalledWith({
        url: mlDestinationStub.lan.url,
        authToken: 'lan-token',
      });
      expect(result.servedWorkloads).toEqual([MlWorkload.RestorationFaithful, MlWorkload.RestorationCreative]);
      expect(result.status).toBe(MlDestinationHealth.Healthy);
    });

    it('keeps the acceleration and GPU memory a restoration worker reported (FL-72)', async () => {
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.lan);
      mocks.machineLearning.probe.mockResolvedValue({
        ...mlProbeStub.restoration,
        hardware: {
          providers: [],
          openvinoDeviceIds: [],
          torchCudaAvailable: false,
          cudaDeviceCount: 1,
          preferredAcceleration: 'cuda' as never,
        },
      });
      mocks.machineLearning.getRestorationModels.mockResolvedValue({
        protocol: RESTORATION_PROTOCOL,
        workloads: [MlWorkload.RestorationFaithful],
        models: [],
        gpus: [{ name: 'NVIDIA RTX 4070 Ti SUPER', memoryTotalBytes: 17_171_480_576, driverVersion: '550.54.14' }],
        configurationProblems: [],
        checkedAt: '2026-09-22T12:00:00.000Z',
      });

      await sut.probe(mlDestinationStub.lan.id);

      expect(mocks.mlDestination.recordProbe).toHaveBeenCalledWith(
        mlDestinationStub.lan.id,
        expect.objectContaining({
          latencyMs: 40,
          hardware: {
            preferredAcceleration: 'cuda',
            providers: [],
            cudaDeviceCount: 1,
            gpus: [{ name: 'NVIDIA RTX 4070 Ti SUPER', memoryTotalBytes: 17_171_480_576 }],
          },
        }),
      );
    });

    it('asks only restoration workers for GPUs', async () => {
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.local);
      mocks.machineLearning.probe.mockResolvedValue(mlProbeStub.healthy);

      await sut.probe(mlDestinationStub.local.id);

      expect(mocks.machineLearning.getRestorationModels).not.toHaveBeenCalled();
      expect(mocks.mlDestination.recordProbe).toHaveBeenCalledWith(
        mlDestinationStub.local.id,
        expect.objectContaining({ hardware: null, latencyMs: 12 }),
      );
    });
  });

  describe('admit', () => {
    it('admits the named destination and returns a measured estimate or null', async () => {
      mocks.mlDestination.getThroughput.mockResolvedValue({
        sampleCount: 3,
        bytesSent: 3000,
        durationMs: 1500,
        spentUsd: 0,
      });

      const result = await sut.admit(mlDestinationStub.local.id, { workload: MlWorkload.Face, jobId: 'job-1' });

      expect(result.destinationId).toBe(mlDestinationStub.local.id);
      expect(result.kind).toBe(MlDestinationKind.Local);
      expect(result.estimate).toEqual({ sampleCount: 3, bytesPerSecond: 2000, windowDays: 30 });
    });

    it('reports no estimate rather than a constant when nothing was measured', async () => {
      const result = await sut.admit(mlDestinationStub.local.id, { workload: MlWorkload.Face });
      expect(result.estimate.bytesPerSecond).toBeNull();
      expect(result.estimate.sampleCount).toBe(0);
    });

    it('refuses instead of answering with another destination', async () => {
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.frameleafCloud);

      const error = await sut
        .admit(mlDestinationStub.frameleafCloud.id, { workload: MlWorkload.Enrichment })
        .catch((error_) => error_);

      expect(error).toBeInstanceOf(MlDestinationRefusedError);
      expect((error as MlDestinationRefusedError).refusal).toBe(MlAdmissionRefusal.ConsentMissing);
    });

    it('returns 404 for an unknown destination', async () => {
      mocks.mlDestination.getById.mockResolvedValue(undefined);
      await expect(sut.admit('missing', { workload: MlWorkload.Face })).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('separate library-analysis and restoration workers (FL-72)', () => {
    it('refuses a destination that would run library analysis and restoration together', async () => {
      await expect(
        sut.create({
          kind: MlDestinationKind.Lan,
          name: 'Everything box',
          url: 'https://gpu.lan:3003',
          workloads: [MlWorkload.Face, MlWorkload.RestorationFaithful],
          enabled: true,
        }),
      ).rejects.toThrow(/not both/);
      expect(mocks.mlDestination.create).not.toHaveBeenCalled();
    });

    it('marks only a restoration worker as sharing hardware with library analysis', async () => {
      await expect(
        sut.create({
          kind: MlDestinationKind.Lan,
          name: 'Study PC',
          url: 'https://study.lan:3003',
          workloads: [MlWorkload.Face],
          enabled: true,
          sharesLibraryHardware: true,
        }),
      ).rejects.toThrow(/Only a restoration worker/);
    });

    it('never marks Frameleaf Cloud as sharing a GPU on this network', async () => {
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.frameleafCloud);
      await expect(sut.update(mlDestinationStub.frameleafCloud.id, { sharesLibraryHardware: true })).rejects.toThrow(
        /cloud worker cannot share/,
      );
    });

    it('still lets an administrator rename or disable a row saved before the rule', async () => {
      const mixed = { ...mlDestinationStub.lan, workloads: [MlWorkload.Face, MlWorkload.RestorationFaithful] };
      mocks.mlDestination.getById.mockResolvedValue(mixed);

      await sut.update(mixed.id, { enabled: false });
      expect(mocks.mlDestination.update).toHaveBeenCalledWith(mixed.id, expect.objectContaining({ enabled: false }));

      await expect(sut.update(mixed.id, { workloads: mixed.workloads })).rejects.toThrow(/not both/);
    });

    it('refuses a restoration route on an endpoint library analysis is routed to', async () => {
      const sameUrl = { ...mlDestinationStub.lan, url: mlDestinationStub.local.url };
      mocks.mlDestination.getById.mockImplementation((id: string) =>
        Promise.resolve(
          id === sameUrl.id ? sameUrl : id === mlDestinationStub.local.id ? mlDestinationStub.local : undefined,
        ),
      );

      await expect(sut.setRoute(MlWorkload.RestorationFaithful, { destinationId: sameUrl.id })).rejects.toThrow(
        /restoration runs only on a separate worker/,
      );
      expect(mocks.mlDestination.setRoute).not.toHaveBeenCalled();
    });

    it('routes restoration to its own worker', async () => {
      mocks.mlDestination.getById.mockImplementation((id: string) =>
        Promise.resolve(id === mlDestinationStub.lan.id ? mlDestinationStub.lan : mlDestinationStub.local),
      );

      await sut.setRoute(MlWorkload.RestorationFaithful, { destinationId: mlDestinationStub.lan.id });

      expect(mocks.mlDestination.setRoute).toHaveBeenCalledWith(
        MlWorkload.RestorationFaithful,
        mlDestinationStub.lan.id,
      );
    });
  });

  describe('getCapabilities', () => {
    beforeEach(() => {
      // Checks made just now: a check older than the freshness window is stale evidence (FL-42).
      vi.useFakeTimers({ now: new Date('2026-09-22T12:05:00.000Z'), toFake: ['Date'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('never counts a stale check as evidence and reports per-destination detail (FL-42)', async () => {
      const lanChecked = {
        ...mlDestinationStub.lan,
        lastProbeHardware: {
          preferredAcceleration: 'cuda',
          providers: [],
          cudaDeviceCount: 1,
          gpus: [{ name: 'RTX', memoryTotalBytes: 12e9 }],
        },
      };
      mocks.mlDestination.getAll.mockResolvedValue([
        { ...lanChecked, lastProbeAt: new Date('2026-09-22T11:00:00.000Z') },
      ]);

      let result = await sut.getCapabilities();
      let faithful = result.workloads.find((entry) => entry.workload === MlWorkload.RestorationFaithful)!;
      expect(faithful.available).toBe(false);
      expect(faithful.destinations[0]).toMatchObject({ stale: true, available: false });

      mocks.mlDestination.getAll.mockResolvedValue([lanChecked]);
      result = await sut.getCapabilities();
      faithful = result.workloads.find((entry) => entry.workload === MlWorkload.RestorationFaithful)!;
      expect(faithful.available).toBe(true);
      expect(faithful.destinations[0]).toMatchObject({
        stale: false,
        leavesNetwork: false,
        acceleration: 'gpu',
        gpuMemoryBytes: 12e9,
        servedWorkloads: [MlWorkload.RestorationFaithful],
        checkedAt: '2026-09-22T12:00:00.000Z',
      });
    });

    it('marks a workload available only when a destination is enabled, consented, allowed, healthy and serving it', async () => {
      mocks.mlDestination.getAll.mockResolvedValue([
        mlDestinationStub.local,
        { ...mlDestinationStub.lan, consentAcknowledgedAt: null },
        mlDestinationStub.frameleafCloud,
      ]);

      const result = await sut.getCapabilities();

      const face = result.workloads.find((entry) => entry.workload === MlWorkload.Face)!;
      expect(face.available).toBe(true);
      expect(face.routedDestinationId).toBe(mlDestinationStub.local.id);
      expect(face.destinations.find((d) => d.id === mlDestinationStub.local.id)?.available).toBe(true);
      // Frameleaf Cloud allows nothing for face and has never been checked healthy.
      expect(face.destinations.find((d) => d.id === mlDestinationStub.frameleafCloud.id)?.available).toBe(false);

      const restoration = result.workloads.find((entry) => entry.workload === MlWorkload.RestorationFaithful)!;
      // The LAN worker allows restoration and its last probe reported it.
      expect(restoration.available).toBe(true);
      expect(restoration.routedDestinationId).toBeNull();
    });

    it('counts Frameleaf Cloud for Studio AI only once both its speech to text and speech models are chosen (FL-186)', async () => {
      const facts = mlDestinationStub.frameleafCloudConsented.lastProbeCloud!;
      const workloads = [MlWorkload.Enrichment, MlWorkload.StudioAi];
      const cloud = {
        ...mlDestinationStub.frameleafCloudConsented,
        workloads,
        lastProbeWorkloads: workloads,
        lastProbeCloud: {
          ...facts,
          defaultModels: {},
          modelIds: [...facts.modelIds, 'studio-words', 'studio-voice'],
          modelGroups: { ...facts.modelGroups, 'studio-words': 'transcription', 'studio-voice': 'tts' },
        },
      };
      mocks.mlDestination.getAll.mockResolvedValue([cloud]);
      mocks.mlDestination.getSpend.mockResolvedValue(0);
      const studioOn = async () => (await sut.getCapabilities()).studio.transcriptionWorker;
      const enrichmentOn = async () =>
        (await sut.getCapabilities()).workloads.find((entry) => entry.workload === MlWorkload.Enrichment)!.available;

      mocks.mlDestination.getCloudModelChoices.mockResolvedValue([
        { modelGroup: 'transcription', modelId: 'studio-words', updatedAt: new Date() },
      ]);
      expect(await studioOn()).toBe(false);
      // no default for descriptions and none chosen: nothing to send
      expect(await enrichmentOn()).toBe(false);

      mocks.mlDestination.getCloudModelChoices.mockResolvedValue([
        { modelGroup: 'transcription', modelId: 'studio-words', updatedAt: new Date() },
        { modelGroup: 'tts', modelId: 'studio-voice', updatedAt: new Date() },
        { modelGroup: 'descriptions', modelId: 'describe-large', updatedAt: new Date() },
      ]);
      expect(await studioOn()).toBe(true);
      expect(await enrichmentOn()).toBe(true);
    });

    describe('render worker (FL-42)', () => {
      const hour = 60 * 60 * 1000;
      const liveSession = (
        worker: Record<string, unknown> = {},
        session: Record<string, unknown> = {},
      ): AuthenticatedRenderWorker =>
        ({
          worker: {
            id: 'worker-1',
            name: 'Studio GPU',
            status: RenderWorkerStatus.Active,
            engineDigest: 'sha256:engine',
            conformanceMaxAgeMs: 24 * hour,
            ...worker,
          },
          session: {
            id: 'session-1',
            workerId: 'worker-1',
            scopes: [MediaOperationKind.StudioExport],
            engineDigest: 'sha256:engine',
            conformanceReportedAt: new Date(Date.now() - hour),
            expiresAt: new Date(Date.now() + hour),
            revokedAt: null,
            ...session,
          },
        }) as unknown as AuthenticatedRenderWorker;

      const studioOf = async (...sessions: AuthenticatedRenderWorker[]) => {
        mocks.renderWorker.listLiveSessions.mockResolvedValue(sessions);
        const { studio } = await sut.getCapabilities();
        return { gpuWorker: studio.gpuWorker, renderWorker: studio.renderWorker };
      };

      it('reports a GPU render worker while a qualified session is admitted', async () => {
        await expect(studioOf(liveSession())).resolves.toEqual({ gpuWorker: true, renderWorker: true });
      });

      it('accepts a worker that is not pinned to an engine digest', async () => {
        await expect(studioOf(liveSession({ engineDigest: null }))).resolves.toEqual({
          gpuWorker: true,
          renderWorker: true,
        });
      });

      it('does not count an expired session', async () => {
        await expect(studioOf(liveSession({}, { expiresAt: new Date(Date.now() - 1000) }))).resolves.toEqual({
          gpuWorker: false,
          renderWorker: false,
        });
      });

      it('does not count a revoked session or a revoked worker', async () => {
        await expect(
          studioOf(
            liveSession({}, { revokedAt: new Date() }),
            liveSession({ status: RenderWorkerStatus.Revoked, revokedAt: new Date() }),
          ),
        ).resolves.toEqual({ gpuWorker: false, renderWorker: false });
      });

      it('does not count a session whose conformance evidence is stale or from the future', async () => {
        await expect(
          studioOf(
            liveSession({ conformanceMaxAgeMs: hour }, { conformanceReportedAt: new Date(Date.now() - 2 * hour) }),
            liveSession({}, { conformanceReportedAt: new Date(Date.now() + 2 * hour) }),
          ),
        ).resolves.toEqual({ gpuWorker: false, renderWorker: false });
      });

      it('does not count a session admitted on another engine than the worker is qualified with', async () => {
        await expect(
          studioOf(liveSession({ engineDigest: 'sha256:requalified' }), liveSession({}, { engineDigest: null })),
        ).resolves.toEqual({ gpuWorker: false, renderWorker: false });
      });

      it('does not count a session that may claim no render work', async () => {
        await expect(studioOf(liveSession({}, { scopes: [] }))).resolves.toEqual({
          gpuWorker: false,
          renderWorker: false,
        });
      });

      it('counts one qualified session among unqualified ones', async () => {
        await expect(
          studioOf(liveSession({}, { revokedAt: new Date() }), liveSession({}, { id: 'session-2' })),
        ).resolves.toEqual({ gpuWorker: true, renderWorker: true });
      });
    });

    it('never claims a render or GPU worker without an admitted session and derives the Studio row from workloads', async () => {
      mocks.mlDestination.getAll.mockResolvedValue([mlDestinationStub.local]);

      const result = await sut.getCapabilities();

      expect(result.studio).toEqual({
        gpuWorker: false,
        renderWorker: false,
        restorationWorker: false,
        transcriptionWorker: false,
        render: [],
      });
    });

    it('does not count an unconsented cloud destination even when it is healthy and serves the workload', async () => {
      mocks.mlDestination.getAll.mockResolvedValue([
        {
          ...mlDestinationStub.frameleafCloud,
          lastProbeHealth: MlDestinationHealth.Healthy,
          lastProbeWorkloads: [MlWorkload.RestorationFaithful],
        },
      ]);

      const result = await sut.getCapabilities();

      expect(result.workloads.find((entry) => entry.workload === MlWorkload.RestorationFaithful)?.available).toBe(
        false,
      );
      expect(result.studio.restorationWorker).toBe(false);
    });
  });

  describe('getRestorationModels', () => {
    it('reports the models a LAN worker verified, including why they are unavailable', async () => {
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.lan);
      const models = [
        {
          id: 'realbasicvsr-x4',
          family: 'realbasicvsr',
          mode: AssetRestorationMode.Faithful,
          displayName: 'RealBasicVSR x4',
          revision: 'REPLACE',
          fingerprint: null,
          state: RestorationModelState.NotPinned,
          reasons: ["revision 'REPLACE' is not an exact 40-character commit"],
          nativeScale: 4,
          maxInputLongEdge: 1280,
          maxFrames: 300,
          dynamicRanges: [RestorationDynamicRange.Sdr],
          measured: [],
          qualificationId: null,
        },
      ];
      mocks.machineLearning.getRestorationModels.mockResolvedValue({
        protocol: RESTORATION_PROTOCOL,
        workloads: [],
        models,
        gpus: [],
        configurationProblems: [],
        checkedAt: '2026-09-22T12:00:00.000Z',
      });

      const result = await sut.getRestorationModels(mlDestinationStub.lan.id);

      expect(mocks.machineLearning.getRestorationModels).toHaveBeenCalledWith({
        url: mlDestinationStub.lan.url,
        authToken: 'lan-token',
      });
      expect(result).toEqual({
        destinationId: mlDestinationStub.lan.id,
        reachable: true,
        error: null,
        workloads: [],
        models,
        gpus: [],
        configurationProblems: [],
        checkedAt: '2026-09-22T12:00:00.000Z',
      });
    });

    it('reports an unreachable worker instead of failing', async () => {
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.local);
      mocks.machineLearning.getRestorationModels.mockRejectedValue(
        new Error('the destination does not run the restoration worker'),
      );

      const result = await sut.getRestorationModels(mlDestinationStub.local.id);

      expect(result).toMatchObject({
        reachable: false,
        error: 'the destination does not run the restoration worker',
        workloads: [],
        models: [],
      });
    });

    it('points to the catalogue for Frameleaf Cloud models instead of asking a worker (FL-159)', async () => {
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.frameleafCloudConsented);

      const result = await sut.getRestorationModels(mlDestinationStub.frameleafCloudConsented.id);

      expect(result).toMatchObject({ reachable: false, error: expect.stringContaining('catalogue') });
      expect(mocks.machineLearning.getRestorationModels).not.toHaveBeenCalled();
    });

    it('throws for an unknown destination', async () => {
      mocks.mlDestination.getById.mockResolvedValue(undefined);

      await expect(sut.getRestorationModels('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('list', () => {
    it('maps rows to DTOs without exposing tokens, and Frameleaf Cloud without any URL (FL-159)', async () => {
      mocks.mlDestination.getAll.mockResolvedValue([mlDestinationStub.lan, mlDestinationStub.frameleafCloudConsented]);
      mocks.mlDestination.getSpend.mockResolvedValue(4.25);

      const [lan, cloud] = await sut.list();

      expect(lan.authTokenConfigured).toBe(true);
      expect(lan.cloud).toBeNull();
      expect(JSON.stringify(lan)).not.toContain('lan-token');
      expect(cloud.url).toBeNull();
      expect(cloud.authTokenConfigured).toBe(false);
      expect(cloud.consent).toEqual({
        required: true,
        acknowledgedAt: expect.any(String),
        acknowledgedBy: 'admin-id',
        version: '2026-09-25',
        requiredVersion: '2026-09-25',
      });
      expect(cloud.cloud).toMatchObject({ region: 'eu', entitled: true, balanceUsd: 40, heldUsd: 5, refusal: null });
      expect(cloud.costControls).toMatchObject({ budgetLimitUsd: 25, spentUsd: 4.25, budgetWindowDays: 30 });
    });
  });
});
