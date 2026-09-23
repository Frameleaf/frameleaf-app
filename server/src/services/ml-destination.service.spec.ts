import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaults } from 'src/config.js';
import { AssetRestorationMode } from 'src/dtos/asset-restoration.dto.js';
import { RESTORATION_PROTOCOL, RestorationDynamicRange, RestorationModelState } from 'src/dtos/restoration-inference.dto.js';
import { ImmichWorker, MlAdmissionRefusal, MlDestinationHealth, MlDestinationKind, MlWorkload } from 'src/enum.js';
import { MlDestinationService } from 'src/services/ml-destination.service.js';
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
    mocks.mlDestination.update.mockImplementation((id, patch) =>
      Promise.resolve({ ...(id === mlDestinationStub.runPod.id ? mlDestinationStub.runPod : mlDestinationStub.local), ...patch } as never),
    );
    mocks.mlDestination.create.mockImplementation((row) =>
      Promise.resolve({ ...mlDestinationStub.local, ...row, id: 'created' } as never),
    );
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
          workloads: [MlWorkload.Face, MlWorkload.Clip, MlWorkload.Ocr, MlWorkload.Enrichment],
        }),
      );
      expect(mocks.mlDestination.setRoute).toHaveBeenCalledTimes(4);
      for (const workload of [MlWorkload.Face, MlWorkload.Clip, MlWorkload.Ocr, MlWorkload.Enrichment]) {
        expect(mocks.mlDestination.setRoute).toHaveBeenCalledWith(workload, 'created');
      }
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
        url: 'http://workshop.lan:3003',
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
        sut.grantConsent(authStub.admin, mlDestinationStub.runPod.id, { acknowledgeMediaLeavesNetwork: false } as never),
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
      expect(mocks.mlDestination.setRoute).toHaveBeenCalledWith(MlWorkload.Enrichment, mlDestinationStub.runPodConsented.id);

      await sut.setRoute(MlWorkload.Enrichment, { destinationId: null });
      expect(mocks.mlDestination.clearRoute).toHaveBeenCalledWith(MlWorkload.Enrichment);
    });

    it('lists every workload, unrouted ones with a null destination', async () => {
      const { routes } = await sut.getRoutes();
      expect(routes).toHaveLength(Object.values(MlWorkload).length);
      expect(routes.find((route) => route.workload === MlWorkload.Face)?.destinationId).toBe(mlDestinationStub.local.id);
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

      const result = await sut.probe(mlDestinationStub.lan.id);

      expect(mocks.machineLearning.probe).toHaveBeenCalledWith({ url: mlDestinationStub.lan.url, authToken: 'lan-token' });
      expect(result.servedWorkloads).toEqual([MlWorkload.RestorationFaithful, MlWorkload.RestorationCreative]);
      expect(result.status).toBe(MlDestinationHealth.Healthy);
    });
  });

  describe('admit', () => {
    it('admits the named destination and returns a measured estimate or null', async () => {
      mocks.mlDestination.getThroughput.mockResolvedValue({ sampleCount: 3, bytesSent: 3000, durationMs: 1500, spentUsd: 0 });

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
      mocks.machineLearning.getRunPodEndpoint.mockReturnValue({ url: 'https://endpoint.api.runpod.ai/', authToken: 'rp' });

      const error = await sut.admit(mlDestinationStub.runPod.id, { workload: MlWorkload.Enrichment }).catch((error_) => error_);

      expect(error).toBeInstanceOf(MlDestinationRefusedError);
      expect((error as MlDestinationRefusedError).refusal).toBe(MlAdmissionRefusal.ConsentMissing);
    });

    it('returns 404 for an unknown destination', async () => {
      mocks.mlDestination.getById.mockResolvedValue(undefined);
      await expect(sut.admit('missing', { workload: MlWorkload.Face })).rejects.toBeInstanceOf(NotFoundException);
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

    it('never claims a render or GPU worker and derives the Studio row from workloads', async () => {
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
          ...mlDestinationStub.runPod,
          lastProbeHealth: MlDestinationHealth.Healthy,
          lastProbeWorkloads: [MlWorkload.RestorationFaithful],
        },
      ]);

      const result = await sut.getCapabilities();

      expect(result.workloads.find((entry) => entry.workload === MlWorkload.RestorationFaithful)?.available).toBe(false);
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
        url: 'http://workshop.lan:3003',
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
      mocks.machineLearning.getRunPodEndpoint.mockReturnValue({ url: 'https://endpoint.api.runpod.ai/', authToken: 'rp' });

      const [lan, runPod] = await sut.list();

      expect(lan.authTokenConfigured).toBe(true);
      expect(JSON.stringify(lan)).not.toContain('lan-token');
      expect(runPod.url).toBe('https://endpoint.api.runpod.ai/');
      expect(runPod.consent).toEqual({ required: true, acknowledgedAt: expect.any(String), acknowledgedBy: 'admin-id' });
      expect(runPod.costControls).toMatchObject({ budgetLimitUsd: 25, spentUsd: 4.25, budgetWindowDays: 30 });
      expect(JSON.stringify(runPod)).not.toContain('"rp"');
    });
  });
});
