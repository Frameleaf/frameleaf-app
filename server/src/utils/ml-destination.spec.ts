import { describe, expect, it, vi } from 'vitest';
import type { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import {
  MlAdmissionRefusal,
  MlDestinationHealth,
  MlDestinationKind,
  MlWorkerAcceleration,
  MlWorkerReadiness,
  MlWorkerRole,
  MlWorkload,
} from 'src/enum.js';
import {
  FRAMELEAF_CLOUD_ENDPOINT,
  type MachineLearningRepository,
  type MlEndpointProbe,
} from 'src/repositories/machine-learning.repository.js';
import {
  MlDestinationNotFoundError,
  MlDestinationRefusedError,
  accelerationOf,
  evaluateAdmission,
  hardwareFromProbe,
  hasRequiredConsent,
  healthFromProbe,
  mlWorkerRoleOf,
  readinessOf,
  resolveEndpoint,
  restorationRoleConflict,
  routedMlDestinationId,
  sameEndpointUrl,
  selectMlDestination,
  summarizeProbe,
  workloadPolicyProblem,
} from 'src/utils/ml-destination.js';
import { mlDestinationStub, mlProbeStub } from 'test/fixtures/ml-destination.stub.js';

const endpoint = { url: 'http://immich-machine-learning:3003' };

const deps = (overrides: {
  destination?: typeof mlDestinationStub.local | undefined;
  probe?: MlEndpointProbe;
  spend?: number;
  route?: { workload: MlWorkload; destinationId: string; modelId?: string | null } | undefined;
}) => {
  const mlDestinationRepository = {
    getById: vi.fn().mockResolvedValue('destination' in overrides ? overrides.destination : mlDestinationStub.local),
    getSpend: vi.fn().mockResolvedValue(overrides.spend ?? 0),
    recordProbe: vi.fn().mockResolvedValue(undefined),
    recordAccounting: vi.fn().mockResolvedValue(undefined),
    getRoute: vi.fn().mockResolvedValue(overrides.route),
  } as unknown as MlDestinationRepository;
  const machineLearningRepository = {
    probe: vi.fn().mockResolvedValue(overrides.probe ?? mlProbeStub.healthy),
  } as unknown as MachineLearningRepository;
  return { mlDestinationRepository, machineLearningRepository };
};

describe('evaluateAdmission', () => {
  const base = {
    destination: mlDestinationStub.local,
    workload: MlWorkload.Face,
    endpoint,
    probe: mlProbeStub.healthy,
    spentUsd: 0,
  };

  it('admits a healthy, enabled local destination that serves the workload', () => {
    expect(evaluateAdmission(base)).toEqual({ admitted: true });
  });

  it('refuses a worker that reported too little GPU memory for the workload (FL-58)', () => {
    const destination = {
      ...mlDestinationStub.local,
      workloads: [MlWorkload.PetRecognition],
      lastProbeHardware: {
        preferredAcceleration: null,
        providers: [],
        cudaDeviceCount: 1,
        gpus: [{ name: 'Tiny', memoryTotalBytes: 512 * 1024 ** 2 }],
      },
    };
    const probe = { ...mlProbeStub.healthy, workloads: [MlWorkload.PetRecognition] };

    expect(evaluateAdmission({ ...base, destination, probe, workload: MlWorkload.PetRecognition })).toEqual({
      admitted: false,
      refusal: MlAdmissionRefusal.InsufficientMemory,
      detail: 'This server has 0.5 GiB of GPU memory; pet-recognition needs 1.0 GiB',
    });
  });

  it('never holds unknown memory against a worker', () => {
    const destination = { ...mlDestinationStub.local, workloads: [MlWorkload.PetRecognition] };
    const probe = { ...mlProbeStub.healthy, workloads: [MlWorkload.PetRecognition] };

    expect(evaluateAdmission({ ...base, destination, probe, workload: MlWorkload.PetRecognition })).toEqual({
      admitted: true,
    });
  });

  it('refuses a missing destination before anything else', () => {
    expect(evaluateAdmission({ ...base, destination: undefined })).toMatchObject({
      admitted: false,
      refusal: MlAdmissionRefusal.DestinationMissing,
    });
  });

  it('refuses a disabled destination', () => {
    expect(evaluateAdmission({ ...base, destination: { ...mlDestinationStub.local, enabled: false } })).toMatchObject({
      admitted: false,
      refusal: MlAdmissionRefusal.DestinationDisabled,
    });
  });

  it('refuses a workload the administrator did not allow', () => {
    expect(evaluateAdmission({ ...base, workload: MlWorkload.RestorationFaithful })).toMatchObject({
      admitted: false,
      refusal: MlAdmissionRefusal.WorkloadNotAllowed,
    });
  });

  it('refuses a cloud destination without recorded consent even when it is healthy', () => {
    expect(
      evaluateAdmission({
        ...base,
        destination: mlDestinationStub.frameleafCloud,
        workload: MlWorkload.Enrichment,
        endpoint: FRAMELEAF_CLOUD_ENDPOINT,
        probe: mlProbeStub.frameleafCloud,
      }),
    ).toMatchObject({ admitted: false, refusal: MlAdmissionRefusal.ConsentMissing });
  });

  it('refuses a cloud destination at its budget limit', () => {
    expect(
      evaluateAdmission({
        ...base,
        destination: mlDestinationStub.frameleafCloudConsented,
        workload: MlWorkload.Enrichment,
        endpoint: FRAMELEAF_CLOUD_ENDPOINT,
        probe: mlProbeStub.frameleafCloud,
        spentUsd: 25,
      }),
    ).toMatchObject({ admitted: false, refusal: MlAdmissionRefusal.BudgetExceeded });
  });

  it('refuses an unreachable destination', () => {
    expect(evaluateAdmission({ ...base, probe: mlProbeStub.unreachable })).toMatchObject({
      admitted: false,
      refusal: MlAdmissionRefusal.DestinationUnhealthy,
    });
  });

  it('refuses when the worker itself does not report the workload, whatever the allow-list says', () => {
    const lan = { ...mlDestinationStub.lan, consentAcknowledgedAt: null };
    expect(
      evaluateAdmission({
        ...base,
        destination: lan,
        workload: MlWorkload.RestorationFaithful,
        endpoint: { url: lan.url!, authToken: 'lan-token' },
        probe: mlProbeStub.healthy,
      }),
    ).toMatchObject({ admitted: false, refusal: MlAdmissionRefusal.WorkloadNotServed });
  });
});

describe('evaluateAdmission for Frameleaf Cloud (FL-159)', () => {
  const facts = mlProbeStub.frameleafCloud.cloud!;
  const cloud = {
    destination: mlDestinationStub.frameleafCloudConsented,
    workload: MlWorkload.RestorationCreative,
    endpoint: FRAMELEAF_CLOUD_ENDPOINT,
    probe: mlProbeStub.frameleafCloud,
    spentUsd: 0,
  };
  const withFacts = (overrides: Partial<typeof facts>) => ({
    ...cloud,
    probe: { ...mlProbeStub.frameleafCloud, cloud: { ...facts, ...overrides } },
  });
  const refusal = (input: Parameters<typeof evaluateAdmission>[0]) => {
    const verdict = evaluateAdmission(input);
    return verdict.admitted ? null : verdict.refusal;
  };

  it('admits a consented, entitled destination with a balance that offers the workload', () => {
    expect(evaluateAdmission(cloud)).toEqual({ admitted: true });
    // Library analysis and restoration may share Frameleaf Cloud: each job gets its own capacity.
    expect(evaluateAdmission({ ...cloud, workload: MlWorkload.Enrichment })).toEqual({ admitted: true });
  });

  it('refuses faces by policy even when a row allows them', () => {
    const faces = { ...mlDestinationStub.frameleafCloudConsented, workloads: [MlWorkload.Face] };
    expect(refusal({ ...cloud, destination: faces, workload: MlWorkload.Face })).toBe(
      MlAdmissionRefusal.WorkloadNotAllowed,
    );
  });

  it('refuses before the first check and when the cloud is unavailable, never falling back', () => {
    expect(refusal({ ...cloud, probe: null })).toBe(MlAdmissionRefusal.DestinationUnhealthy);
    expect(refusal({ ...cloud, probe: { ...mlProbeStub.unreachable, cloud: null } })).toBe(
      MlAdmissionRefusal.CloudUnavailable,
    );
  });

  it('maps a refused check to its reason', () => {
    for (const reason of [
      MlAdmissionRefusal.CloudUnavailable,
      MlAdmissionRefusal.QuotaExceeded,
      MlAdmissionRefusal.WalletInsufficient,
      MlAdmissionRefusal.ConsentVersionOutdated,
    ]) {
      expect(refusal(withFacts({ refusal: { refusal: reason, detail: 'refused' } }))).toBe(reason);
      expect(
        refusal({
          ...cloud,
          probe: { ...mlProbeStub.unreachable, cloud: { ...facts, refusal: { refusal: reason, detail: 'refused' } } },
        }),
      ).toBe(reason);
    }
  });

  it('refuses without the entitlement', () => {
    expect(refusal(withFacts({ entitled: false }))).toBe(MlAdmissionRefusal.EntitlementMissing);
  });

  it('refuses a consent older than the version the cloud requires now', () => {
    expect(refusal(withFacts({ consentRequiredVersion: '2026-10-01' }))).toBe(
      MlAdmissionRefusal.ConsentVersionOutdated,
    );
  });

  it('refuses an empty wallet and a hold the wallet cannot cover', () => {
    expect(refusal(withFacts({ balanceUsd: 0, heldUsd: 0 }))).toBe(MlAdmissionRefusal.WalletInsufficient);
    expect(refusal(withFacts({ balanceUsd: 10, heldUsd: 10 }))).toBe(MlAdmissionRefusal.WalletInsufficient);
    expect(refusal({ ...cloud, holdUsd: 36 })).toBe(MlAdmissionRefusal.WalletInsufficient);
    expect(refusal({ ...cloud, holdUsd: 35 })).toBeNull();
  });

  it("refuses once today's AI Wallet limit is reached", () => {
    expect(refusal(withFacts({ dailyCapUsd: 5, spentTodayUsd: 5 }))).toBe(MlAdmissionRefusal.BudgetExceeded);
  });

  it('refuses a model that is not in the catalogue any more', () => {
    expect(refusal({ ...cloud, modelId: 'retired-model' })).toBe(MlAdmissionRefusal.ModelMismatch);
    expect(refusal({ ...cloud, modelId: 'restore-faithful' })).toBeNull();
  });

  it('refuses a cloud job for the local-only nllb-clip, MusicGen-small and Qwen2.5-VL-3B models, even if listed (FL-146)', () => {
    for (const modelId of [
      'nllb-clip-base-siglip__mrl',
      'nllb-clip-large-siglip__v1',
      'Xenova/musicgen-small',
      'Qwen/Qwen2.5-VL-3B-Instruct',
      'llmware/qwen2.5-vl-3b-ov',
    ]) {
      expect(refusal({ ...withFacts({ modelIds: ['restore-faithful', modelId] }), modelId })).toBe(
        MlAdmissionRefusal.ModelMismatch,
      );
    }
  });

  it('refuses a workload the cloud does not offer this account right now', () => {
    expect(refusal({ ...cloud, probe: { ...mlProbeStub.frameleafCloud, workloads: [MlWorkload.Enrichment] } })).toBe(
      MlAdmissionRefusal.WorkloadNotServed,
    );
  });
});

describe('resolveEndpoint', () => {
  it('uses the stored URL and token for local and LAN destinations', () => {
    expect(resolveEndpoint(mlDestinationStub.local)).toEqual({ url: mlDestinationStub.local.url });
    expect(resolveEndpoint(mlDestinationStub.lan)).toEqual({
      url: mlDestinationStub.lan.url,
      authToken: 'lan-token',
    });
  });

  it('resolves Frameleaf Cloud to its sentinel, never to a URL or token of its own (FL-159)', () => {
    expect(resolveEndpoint(mlDestinationStub.frameleafCloudConsented)).toBe(FRAMELEAF_CLOUD_ENDPOINT);
    expect(
      resolveEndpoint({ ...mlDestinationStub.frameleafCloudConsented, url: 'https://elsewhere', authToken: 't' }),
    ).toBe(FRAMELEAF_CLOUD_ENDPOINT);
  });

  it('resolves a local destination without a URL to nothing', () => {
    expect(resolveEndpoint({ ...mlDestinationStub.local, url: null })).toBeNull();
  });
});

describe('consent and probe helpers', () => {
  it('requires consent for cloud kinds only', () => {
    expect(hasRequiredConsent(mlDestinationStub.local)).toBe(true);
    expect(hasRequiredConsent(mlDestinationStub.frameleafCloud)).toBe(false);
    expect(hasRequiredConsent(mlDestinationStub.frameleafCloudConsented)).toBe(true);
  });

  it('derives health and a readable summary from a probe', () => {
    expect(healthFromProbe(mlProbeStub.healthy)).toBe(MlDestinationHealth.Healthy);
    expect(healthFromProbe(mlProbeStub.unreachable)).toBe(MlDestinationHealth.Unhealthy);
    expect(summarizeProbe(mlProbeStub.unreachable)).toBe('Unreachable: fetch failed');
    expect(summarizeProbe(mlProbeStub.healthy)).toContain('Serves face, clip, ocr, enrichment');
  });
});

describe('selectMlDestination', () => {
  it('admits Frameleaf Cloud through its delegated check and records the cloud facts (FL-159)', async () => {
    const d = deps({ destination: mlDestinationStub.frameleafCloudConsented, probe: mlProbeStub.frameleafCloud });
    const selection = await selectMlDestination(d, {
      workload: MlWorkload.RestorationFaithful,
      destinationId: mlDestinationStub.frameleafCloudConsented.id,
    });
    expect(selection.endpoint).toBe(FRAMELEAF_CLOUD_ENDPOINT);
    expect(d.machineLearningRepository.probe).toHaveBeenCalledWith(FRAMELEAF_CLOUD_ENDPOINT, {
      maxAgeMs: expect.any(Number),
    });
    expect(d.mlDestinationRepository.recordProbe).toHaveBeenCalledWith(
      mlDestinationStub.frameleafCloudConsented.id,
      expect.objectContaining({ cloud: mlProbeStub.frameleafCloud.cloud }),
    );
  });

  it('refuses the routed model when the catalogue dropped it, and never picks another (FL-159)', async () => {
    const d = deps({
      destination: mlDestinationStub.frameleafCloudConsented,
      probe: mlProbeStub.frameleafCloud,
      route: {
        workload: MlWorkload.Enrichment,
        destinationId: mlDestinationStub.frameleafCloudConsented.id,
        modelId: 'retired-model',
      },
    });
    const error = await selectMlDestination(d, {
      workload: MlWorkload.Enrichment,
      destinationId: mlDestinationStub.frameleafCloudConsented.id,
    }).catch((error_) => error_);
    expect((error as MlDestinationRefusedError).refusal).toBe(MlAdmissionRefusal.ModelMismatch);
  });

  it('admits and returns a selection whose accounting hook records the request', async () => {
    const d = deps({});
    const selection = await selectMlDestination(d, {
      workload: MlWorkload.Face,
      destinationId: 'ml-destination-local',
      jobId: 'asset-1',
      jobName: 'faceDetection',
    });

    expect(selection).toMatchObject({
      destinationId: 'ml-destination-local',
      kind: MlDestinationKind.Local,
      workload: MlWorkload.Face,
      endpoint,
    });
    expect(d.machineLearningRepository.probe).toHaveBeenCalledWith(endpoint, { maxAgeMs: expect.any(Number) });
    expect(d.mlDestinationRepository.recordProbe).toHaveBeenCalledWith(
      'ml-destination-local',
      expect.objectContaining({ health: MlDestinationHealth.Healthy }),
    );

    selection.record({ bytesSent: 1024, bytesReceived: 64, durationMs: 40, outcome: 'success' });
    await vi.waitFor(() =>
      expect(d.mlDestinationRepository.recordAccounting).toHaveBeenCalledWith(
        expect.objectContaining({
          destinationId: 'ml-destination-local',
          destinationKind: MlDestinationKind.Local,
          workload: MlWorkload.Face,
          jobId: 'asset-1',
          jobName: 'faceDetection',
          bytesSent: 1024,
          bytesReceived: 64,
          durationMs: 40,
          outcome: 'success',
        }),
      ),
    );
  });

  it('throws not-found for an unknown destination and never probes anything', async () => {
    const d = deps({ destination: undefined });
    await expect(selectMlDestination(d, { workload: MlWorkload.Face, destinationId: 'gone' })).rejects.toBeInstanceOf(
      MlDestinationNotFoundError,
    );
    expect(d.machineLearningRepository.probe).not.toHaveBeenCalled();
  });

  it('refuses an unconsented cloud destination before touching the network', async () => {
    const d = deps({ destination: mlDestinationStub.frameleafCloud });
    const error = await selectMlDestination(d, {
      workload: MlWorkload.Enrichment,
      destinationId: mlDestinationStub.frameleafCloud.id,
    }).catch((error_) => error_);
    expect(error).toBeInstanceOf(MlDestinationRefusedError);
    expect((error as MlDestinationRefusedError).refusal).toBe(MlAdmissionRefusal.ConsentMissing);
    expect(d.machineLearningRepository.probe).not.toHaveBeenCalled();
  });

  it('refuses when the destination is unreachable and records the failed probe', async () => {
    const d = deps({ probe: mlProbeStub.unreachable });
    const error = await selectMlDestination(d, {
      workload: MlWorkload.Face,
      destinationId: 'ml-destination-local',
    }).catch((error_) => error_);
    expect((error as MlDestinationRefusedError).refusal).toBe(MlAdmissionRefusal.DestinationUnhealthy);
    expect(d.mlDestinationRepository.recordProbe).toHaveBeenCalledWith(
      'ml-destination-local',
      expect.objectContaining({ health: MlDestinationHealth.Unhealthy, workloads: null }),
    );
  });

  it('checks the budget only when a limit is set', async () => {
    const d = deps({});
    await selectMlDestination(d, { workload: MlWorkload.Face, destinationId: 'ml-destination-local' });
    expect(d.mlDestinationRepository.getSpend).not.toHaveBeenCalled();
  });
});

describe('routedMlDestinationId', () => {
  it('returns the routed destination', async () => {
    const d = deps({ route: { workload: MlWorkload.Clip, destinationId: 'ml-destination-local' } });
    await expect(routedMlDestinationId(d.mlDestinationRepository, MlWorkload.Clip)).resolves.toBe(
      'ml-destination-local',
    );
  });

  it('refuses an unrouted workload instead of choosing a destination', async () => {
    const d = deps({ route: undefined });
    const error = await routedMlDestinationId(d.mlDestinationRepository, MlWorkload.Ocr).catch((error_) => error_);
    expect(error).toBeInstanceOf(MlDestinationRefusedError);
    expect((error as MlDestinationRefusedError).refusal).toBe(MlAdmissionRefusal.WorkloadNotRouted);
  });
});

describe('library-analysis and restoration workers stay separate (FL-72)', () => {
  const restorationProbe = mlProbeStub.restoration;

  it('names a worker by the workloads it is allowed to run', () => {
    expect(mlWorkerRoleOf([MlWorkload.Face, MlWorkload.Clip])).toBe(MlWorkerRole.LibraryAnalysis);
    expect(mlWorkerRoleOf([MlWorkload.RestorationCreative])).toBe(MlWorkerRole.Restoration);
    expect(mlWorkerRoleOf([MlWorkload.StudioAi])).toBe(MlWorkerRole.Studio);
    expect(mlWorkerRoleOf([MlWorkload.Ocr, MlWorkload.RestorationFaithful])).toBe(MlWorkerRole.Mixed);
    expect(mlWorkerRoleOf([])).toBe(MlWorkerRole.Unassigned);
  });

  it('refuses a destination that would run library analysis and restoration together', () => {
    expect(workloadPolicyProblem(MlDestinationKind.Lan, [MlWorkload.Face, MlWorkload.RestorationFaithful])).toMatch(
      /not both/,
    );
    expect(workloadPolicyProblem(MlDestinationKind.Lan, [MlWorkload.RestorationFaithful])).toBeNull();
    expect(workloadPolicyProblem(MlDestinationKind.Local, [MlWorkload.Face, MlWorkload.Clip])).toBeNull();
  });

  it('lets Frameleaf Cloud mix only the workloads it offers, and never faces (FL-159)', () => {
    expect(
      workloadPolicyProblem(MlDestinationKind.FrameleafCloud, [MlWorkload.Enrichment, MlWorkload.RestorationCreative]),
    ).toBeNull();
    expect(workloadPolicyProblem(MlDestinationKind.FrameleafCloud, [MlWorkload.Face])).toMatch(
      /face stays on this network/,
    );
    expect(workloadPolicyProblem(MlDestinationKind.FrameleafCloud, [MlWorkload.Clip, MlWorkload.Ocr])).toMatch(
      /clip, ocr stays/,
    );
    expect(
      workloadPolicyProblem(MlDestinationKind.FrameleafCloud, [
        MlWorkload.Upscale,
        MlWorkload.Interpolation,
        MlWorkload.StudioAi,
      ]),
    ).toBeNull();
    // Studio exports render at home only (§2.7).
    expect(workloadPolicyProblem(MlDestinationKind.FrameleafCloud, [MlWorkload.StudioRender])).toMatch(
      /studio-render stays/,
    );
  });

  it('refuses restoration on a row saved before FL-72 that also allows library analysis', () => {
    const mixed = { ...mlDestinationStub.lan, workloads: [MlWorkload.Face, MlWorkload.RestorationFaithful] };
    expect(
      evaluateAdmission({
        destination: mixed,
        workload: MlWorkload.RestorationFaithful,
        endpoint: { url: mixed.url!, authToken: 'lan-token' },
        probe: restorationProbe,
        spentUsd: 0,
      }),
    ).toMatchObject({ admitted: false, refusal: MlAdmissionRefusal.RoleConflict });
    // Library analysis on the same row is untouched.
    expect(
      evaluateAdmission({
        destination: mixed,
        workload: MlWorkload.Face,
        endpoint: { url: mixed.url!, authToken: 'lan-token' },
        probe: mlProbeStub.healthy,
        spentUsd: 0,
      }),
    ).toEqual({ admitted: true });
  });

  it('never reports a role conflict for Frameleaf Cloud, which schedules each job on its own capacity', async () => {
    const d = conflictDeps(
      [mlDestinationStub.frameleafCloudConsented],
      [{ workload: MlWorkload.Enrichment, destinationId: mlDestinationStub.frameleafCloudConsented.id }],
    );
    await expect(
      restorationRoleConflict(d, mlDestinationStub.frameleafCloudConsented, MlWorkload.RestorationCreative),
    ).resolves.toBeNull();
  });

  const conflictDeps = (
    rows: Array<typeof mlDestinationStub.local>,
    routes: Array<{ workload: MlWorkload; destinationId: string }>,
  ) => ({
    mlDestinationRepository: {
      getById: vi.fn().mockImplementation((id: string) => Promise.resolve(rows.find((row) => row.id === id))),
      getRoutes: vi.fn().mockResolvedValue(routes),
    } as unknown as MlDestinationRepository,
  });

  it('allows restoration on its own worker', async () => {
    const d = conflictDeps(
      [mlDestinationStub.local, mlDestinationStub.lan],
      [{ workload: MlWorkload.Face, destinationId: mlDestinationStub.local.id }],
    );
    await expect(restorationRoleConflict(d, mlDestinationStub.lan, MlWorkload.RestorationFaithful)).resolves.toBeNull();
  });

  it('refuses restoration on the endpoint a library workload is routed to, even under another name', async () => {
    const sameUrl = { ...mlDestinationStub.lan, url: 'http://immich-machine-learning:3003/' };
    const d = conflictDeps(
      [mlDestinationStub.local, sameUrl],
      [{ workload: MlWorkload.Clip, destinationId: mlDestinationStub.local.id }],
    );
    await expect(restorationRoleConflict(d, sameUrl, MlWorkload.RestorationFaithful)).resolves.toMatch(/clip/);
  });

  it('never refuses library work, whatever restoration uses', async () => {
    const d = conflictDeps(
      [mlDestinationStub.lan],
      [{ workload: MlWorkload.RestorationFaithful, destinationId: mlDestinationStub.lan.id }],
    );
    await expect(restorationRoleConflict(d, mlDestinationStub.local, MlWorkload.Face)).resolves.toBeNull();
    expect(d.mlDestinationRepository.getRoutes).not.toHaveBeenCalled();
  });

  it('compares endpoints without caring about a trailing slash', () => {
    expect(sameEndpointUrl('http://gpu:3004', 'http://GPU:3004/')).toBe(true);
    expect(sameEndpointUrl('http://gpu:3003', 'http://gpu:3004')).toBe(false);
  });
});

describe('worker readiness (FL-72)', () => {
  const cpuHardware = {
    preferredAcceleration: 'auto',
    providers: ['CPUExecutionProvider'],
    cudaDeviceCount: 0,
    gpus: [],
  };
  const cudaHardware = {
    preferredAcceleration: 'cuda',
    providers: ['CUDAExecutionProvider', 'CPUExecutionProvider'],
    cudaDeviceCount: 1,
    gpus: [],
  };

  it('tells a CPU-only worker from an accelerated one and never guesses without facts', () => {
    expect(accelerationOf(null)).toBe(MlWorkerAcceleration.Unknown);
    expect(accelerationOf(cpuHardware)).toBe(MlWorkerAcceleration.Cpu);
    expect(accelerationOf(cudaHardware)).toBe(MlWorkerAcceleration.Gpu);
    expect(accelerationOf({ ...cpuHardware, gpus: [{ name: 'RTX 4070', memoryTotalBytes: 12e9 }] })).toBe(
      MlWorkerAcceleration.Gpu,
    );
  });

  it('keeps hardware only from a worker that answered', () => {
    expect(hardwareFromProbe(mlProbeStub.unreachable)).toBeNull();
    expect(hardwareFromProbe(mlProbeStub.healthy)).toBeNull();
    expect(
      hardwareFromProbe({
        reachable: true,
        hardware: {
          providers: ['CPUExecutionProvider'],
          openvinoDeviceIds: [],
          torchCudaAvailable: false,
          cudaDeviceCount: 0,
          preferredAcceleration: 'auto' as never,
        },
      }),
    ).toEqual(cpuHardware);
  });

  it('distinguishes unknown, unreachable, not serving, CPU and model-ready', () => {
    const local = mlDestinationStub.local;
    expect(readinessOf({ ...local, lastProbeHealth: MlDestinationHealth.Unknown })).toBe(MlWorkerReadiness.Unknown);
    expect(readinessOf({ ...local, enabled: false })).toBe(MlWorkerReadiness.Disabled);
    expect(readinessOf({ ...local, lastProbeHealth: MlDestinationHealth.Unhealthy, lastProbeWorkloads: null })).toBe(
      MlWorkerReadiness.Unreachable,
    );
    expect(readinessOf({ ...local, lastProbeWorkloads: [MlWorkload.StudioAi] })).toBe(MlWorkerReadiness.NotServing);
    expect(readinessOf({ ...local, lastProbeHardware: cpuHardware })).toBe(MlWorkerReadiness.Cpu);
    expect(readinessOf({ ...local, lastProbeHardware: cudaHardware })).toBe(MlWorkerReadiness.ModelReady);
    expect(readinessOf({ ...local, lastProbeHardware: null })).toBe(MlWorkerReadiness.ModelReady);
  });
});
