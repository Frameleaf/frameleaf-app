import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  MlWorkerRole,
  MlWorkload,
  RenderWorkerStatus,
} from 'src/enum.js';
import { ML_URL_REMOVED_SUMMARY, MlDestinationService } from 'src/services/ml-destination.service.js';
import { MlDestinationRefusedError } from 'src/utils/ml-destination.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { mlDestinationStub, mlProbeStub } from 'test/fixtures/ml-destination.stub.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(MlDestinationService.name, () => {
  let sut: MlDestinationService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(MlDestinationService));
    mocks.mlDestination.getAll.mockResolvedValue([mlDestinationStub.local, mlDestinationStub.runPod]);
    mocks.mlDestination.getRoutes.mockResolvedValue([
      { workload: MlWorkload.Face, destinationId: mlDestinationStub.local.id, updatedAt: new Date() },
    ]);
    mocks.mlDestination.getThroughput.mockResolvedValue({ sampleCount: 0, bytesSent: 0, durationMs: 0, spentUsd: 0 });
    // Like the database, an update leaves a column alone when the patch leaves it undefined.
    mocks.mlDestination.update.mockImplementation((id, patch) =>
      Promise.resolve({
        ...(id === mlDestinationStub.runPod.id ? mlDestinationStub.runPod : mlDestinationStub.local),
        ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
      } as never),
    );
    mocks.mlDestination.setRoute.mockResolvedValue();
    mocks.mlDestination.clearRoute.mockResolvedValue();
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
            : { workload, destinationId: mlDestinationStub.local.id, updatedAt: new Date() },
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

    it('never creates a RunPod destination or routes restoration and Studio work on its own', async () => {
      mocks.mlDestination.getByUrl.mockResolvedValue(mlDestinationStub.local);
      mocks.mlDestination.getRoute.mockResolvedValue(undefined);
      (mocks.config.getWorker as ReturnType<typeof vi.fn>).mockReturnValue(ImmichWorker.Microservices);

      await sut.onConfigInit({
        newConfig: {
          ...defaults,
          machineLearning: {
            ...defaults.machineLearning,
            runpod: { ...defaults.machineLearning.runpod, enabled: true, mode: 'serverless' as const },
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
    it('refuses a RunPod destination with its own URL or token', async () => {
      await expect(
        sut.create({ kind: MlDestinationKind.RunPod, name: 'RunPod', url: 'https://x', workloads: [], enabled: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a second RunPod destination', async () => {
      await expect(
        sut.create({ kind: MlDestinationKind.RunPod, name: 'RunPod 2', workloads: [], enabled: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
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
    it('records consent for a cloud destination with the acting administrator', async () => {
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.runPod);

      const result = await sut.grantConsent(authStub.admin, mlDestinationStub.runPod.id, {
        acknowledgeMediaLeavesNetwork: true,
      });

      expect(mocks.mlDestination.update).toHaveBeenCalledWith(mlDestinationStub.runPod.id, {
        consentAcknowledgedAt: expect.any(Date),
        consentAcknowledgedBy: authStub.admin.user.id,
      });
      expect(result.consent.acknowledgedBy).toBe(authStub.admin.user.id);
    });

    it('refuses consent on a destination that keeps media on the network', async () => {
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.local);
      await expect(
        sut.grantConsent(authStub.admin, mlDestinationStub.local.id, { acknowledgeMediaLeavesNetwork: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a consent body that is not the literal acknowledgement', async () => {
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.runPod);
      await expect(
        sut.grantConsent(authStub.admin, mlDestinationStub.runPod.id, {
          acknowledgeMediaLeavesNetwork: false,
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.mlDestination.update).not.toHaveBeenCalled();
    });

    it('revokes consent by clearing both fields', async () => {
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.runPodConsented);
      await sut.revokeConsent(mlDestinationStub.runPodConsented.id);
      expect(mocks.mlDestination.update).toHaveBeenCalledWith(mlDestinationStub.runPodConsented.id, {
        consentAcknowledgedAt: null,
        consentAcknowledgedBy: null,
      });
    });
  });

  describe('setRoute', () => {
    it('refuses routing to a cloud destination without consent', async () => {
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.runPod);
      await expect(
        sut.setRoute(MlWorkload.Enrichment, { destinationId: mlDestinationStub.runPod.id }),
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
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.runPodConsented);
      await sut.setRoute(MlWorkload.Enrichment, { destinationId: mlDestinationStub.runPodConsented.id });
      expect(mocks.mlDestination.setRoute).toHaveBeenCalledWith(
        MlWorkload.Enrichment,
        mlDestinationStub.runPodConsented.id,
      );

      await sut.setRoute(MlWorkload.Enrichment, { destinationId: null });
      expect(mocks.mlDestination.clearRoute).toHaveBeenCalledWith(MlWorkload.Enrichment);
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
    it('records an unresolved RunPod destination as unhealthy without touching the network', async () => {
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.runPodConsented);
      mocks.machineLearning.getRunPodEndpoint.mockReturnValue(null);

      const result = await sut.probe(mlDestinationStub.runPodConsented.id);

      expect(result.status).toBe(MlDestinationHealth.Unhealthy);
      expect(mocks.machineLearning.probe).not.toHaveBeenCalled();
      expect(mocks.mlDestination.recordProbe).toHaveBeenCalledWith(
        mlDestinationStub.runPodConsented.id,
        expect.objectContaining({ health: MlDestinationHealth.Unhealthy, workloads: null }),
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
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.runPod);
      mocks.machineLearning.getRunPodEndpoint.mockReturnValue({
        url: 'https://endpoint.api.runpod.ai/',
        authToken: 'rp',
      });

      const error = await sut
        .admit(mlDestinationStub.runPod.id, { workload: MlWorkload.Enrichment })
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

    it('never offers the managed RunPod pod for restoration', async () => {
      mocks.mlDestination.getAll.mockResolvedValue([mlDestinationStub.local]);
      await expect(
        sut.create({
          kind: MlDestinationKind.RunPod,
          name: 'RunPod',
          workloads: [MlWorkload.RestorationCreative],
          enabled: true,
        }),
      ).rejects.toThrow(/library analysis only/);
    });

    it('needs the persistent worker URL for a RunPod video worker', async () => {
      await expect(
        sut.create({
          kind: MlDestinationKind.RunPodVideo,
          name: 'RunPod video worker',
          workloads: [MlWorkload.RestorationCreative],
          enabled: true,
        }),
      ).rejects.toThrow(/URL of the persistent worker/);
    });

    it('creates a RunPod video worker that needs consent and keeps its own token hidden', async () => {
      mocks.mlDestination.create.mockResolvedValue({ ...mlDestinationStub.runPodVideo, id: 'created' });

      const result = await sut.create({
        kind: MlDestinationKind.RunPodVideo,
        name: 'RunPod video worker',
        url: 'https://video-worker.proxy.runpod.net',
        authToken: 'video-token',
        workloads: [MlWorkload.RestorationFaithful, MlWorkload.RestorationCreative],
        enabled: true,
        sharesLibraryHardware: false,
      });

      expect(mocks.mlDestination.create).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: MlDestinationKind.RunPodVideo,
          authToken: 'video-token',
          sharesLibraryHardware: false,
        }),
      );
      expect(result.role).toBe(MlWorkerRole.Restoration);
      expect(result.consent.required).toBe(true);
      expect(result.authTokenConfigured).toBe(true);
      expect(JSON.stringify(result)).not.toContain('video-token');
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

    it('never marks a RunPod video worker as sharing a GPU on this network', async () => {
      await expect(
        sut.create({
          kind: MlDestinationKind.RunPodVideo,
          name: 'RunPod video worker',
          url: 'https://video-worker.proxy.runpod.net',
          workloads: [MlWorkload.RestorationFaithful],
          enabled: true,
          sharesLibraryHardware: true,
        }),
      ).rejects.toThrow(/cloud worker cannot share/);
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
    it('marks a workload available only when a destination is enabled, consented, allowed, healthy and serving it', async () => {
      mocks.mlDestination.getAll.mockResolvedValue([
        mlDestinationStub.local,
        { ...mlDestinationStub.lan, consentAcknowledgedAt: null },
        mlDestinationStub.runPodConsented,
      ]);

      const result = await sut.getCapabilities();

      const face = result.workloads.find((entry) => entry.workload === MlWorkload.Face)!;
      expect(face.available).toBe(true);
      expect(face.routedDestinationId).toBe(mlDestinationStub.local.id);
      expect(face.destinations.find((d) => d.id === mlDestinationStub.local.id)?.available).toBe(true);
      // RunPod allows nothing for face and has never been probed healthy.
      expect(face.destinations.find((d) => d.id === mlDestinationStub.runPodConsented.id)?.available).toBe(false);

      const restoration = result.workloads.find((entry) => entry.workload === MlWorkload.RestorationFaithful)!;
      // The LAN worker allows restoration and its last probe reported it.
      expect(restoration.available).toBe(true);
      expect(restoration.routedDestinationId).toBeNull();
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
      });
    });

    it('does not count an unconsented cloud destination even when it is healthy and serves the workload', async () => {
      mocks.mlDestination.getAll.mockResolvedValue([
        {
          ...mlDestinationStub.runPodVideo,
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

    it('does not ask a RunPod destination that has no running worker', async () => {
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.runPodConsented);
      mocks.machineLearning.getRunPodEndpoint.mockReturnValue(null);

      const result = await sut.getRestorationModels(mlDestinationStub.runPodConsented.id);

      expect(result).toMatchObject({ reachable: false, error: 'No running pod or ready serverless worker' });
      expect(mocks.machineLearning.getRestorationModels).not.toHaveBeenCalled();
    });

    it('throws for an unknown destination', async () => {
      mocks.mlDestination.getById.mockResolvedValue(undefined);

      await expect(sut.getRestorationModels('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('list', () => {
    it('maps rows to DTOs without exposing tokens and with the RunPod URL from the published endpoint', async () => {
      mocks.mlDestination.getAll.mockResolvedValue([mlDestinationStub.lan, mlDestinationStub.runPodConsented]);
      mocks.mlDestination.getSpend.mockResolvedValue(4.25);
      mocks.machineLearning.getRunPodEndpoint.mockReturnValue({
        url: 'https://endpoint.api.runpod.ai/',
        authToken: 'rp',
      });

      const [lan, runPod] = await sut.list();

      expect(lan.authTokenConfigured).toBe(true);
      expect(JSON.stringify(lan)).not.toContain('lan-token');
      expect(runPod.url).toBe('https://endpoint.api.runpod.ai/');
      expect(runPod.consent).toEqual({
        required: true,
        acknowledgedAt: expect.any(String),
        acknowledgedBy: 'admin-id',
      });
      expect(runPod.costControls).toMatchObject({ budgetLimitUsd: 25, spentUsd: 4.25, budgetWindowDays: 30 });
      expect(JSON.stringify(runPod)).not.toContain('"rp"');
    });
  });
});
