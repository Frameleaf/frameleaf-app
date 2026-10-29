import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import type { CloudProbeFacts } from 'src/utils/frameleaf-cloud.js';
import { AssetRestorationMode } from 'src/dtos/asset-restoration.dto.js';
import { RestorationModelState } from 'src/dtos/restoration-inference.dto.js';
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
  type MlSelection,
} from 'src/repositories/machine-learning.repository.js';
import * as cloudDisclosure from 'src/utils/frameleaf-cloud.js';
import {
  MlDestinationNotFoundError,
  MlDestinationRefusedError,
  STOPS_CREATED_CLOUD_JOB,
  accelerationOf,
  clipTextDestinationId,
  cloudRouteAllows,
  evaluateAdmission,
  frameleafCloudEligibility,
  hardwareFromProbe,
  hasRequiredConsent,
  healthFromProbe,
  mlWorkerRoleOf,
  readCloudModelChoices,
  readinessOf,
  resolveEndpoint,
  restorationModelsFromReport,
  restorationRoleConflict,
  routedMlDestinationId,
  sameEndpointUrl,
  selectMlDestination,
  storedAdmission,
  storedProbe,
  storedRestorationModels,
  summarizeProbe,
  workloadPolicyProblem,
} from 'src/utils/ml-destination.js';
import { mlDestinationStub, mlProbeStub } from 'test/fixtures/ml-destination.stub.js';

beforeEach(() => vi.restoreAllMocks());

const endpoint = { url: 'http://frameleaf-machine-learning:3003' };

const deps = (overrides: {
  destination?: typeof mlDestinationStub.local | undefined;
  probe?: MlEndpointProbe;
  spend?: number;
  route?: { workload: MlWorkload; destinationId: string } | undefined;
  /** FL-186: the chosen Frameleaf Cloud model per model group. */
  choices?: Record<string, string>;
}) => {
  const mlDestinationRepository = {
    assertRecoveryAuthority: vi.fn().mockResolvedValue(undefined),
    getById: vi.fn().mockResolvedValue('destination' in overrides ? overrides.destination : mlDestinationStub.local),
    getSpend: vi.fn().mockResolvedValue(overrides.spend ?? 0),
    recordProbe: vi.fn().mockResolvedValue(undefined),
    recordAccounting: vi.fn().mockResolvedValue(undefined),
    getRoute: vi.fn().mockResolvedValue(overrides.route),
    getCloudModelChoice: vi.fn((group: string) => Promise.resolve(overrides.choices?.[group] ?? null)),
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
      detail: 'This server has 0.5 GB of GPU memory; pet-recognition needs 1.1 GB',
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

describe('Frameleaf Cloud downstream model/budget mechanics (workload-policy mocked; not disclosure qualification)', () => {
  beforeEach(() => vi.spyOn(cloudDisclosure, 'hasPendingCloudDisclosure').mockReturnValue(false));
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

  describe('smart search and faces (FL-455)', () => {
    const library = {
      ...mlDestinationStub.frameleafCloudConsented,
      workloads: [MlWorkload.Face, MlWorkload.Clip],
    };
    /** A check where the cloud offers smart search and faces with this server's own models. */
    const offered = (features?: Partial<typeof facts.features>) => ({
      ...cloud,
      destination: library,
      probe: {
        ...mlProbeStub.frameleafCloud,
        workloads: [...mlProbeStub.frameleafCloud.workloads, MlWorkload.Clip, MlWorkload.Face],
        cloud: {
          ...facts,
          features: { ...facts.features, ...(features ?? { smartSearch: true, faceRecognition: true }) },
          modelIds: [...facts.modelIds, 'ms_clip', 'ms_face'],
          modelGroups: { ...facts.modelGroups, ms_clip: 'clip', ms_face: 'face' },
          localModels: { [MlWorkload.Clip]: 'ms_clip', [MlWorkload.Face]: 'ms_face' },
        },
      },
    });

    it('never reads a cloud routing mode for them: their one place is the destination route, never "both"', () => {
      const routing = {
        descriptions: 'local',
        upscale: 'local',
        restoration: 'local',
        studio: 'local',
        interpolation: 'local',
      } as const;
      for (const workload of [MlWorkload.Clip, MlWorkload.Face]) {
        expect(cloudRouteAllows({ routing }, workload)).toBe(true);
        expect(
          cloudRouteAllows({ routing: { ...routing, search: 'local', faces: 'local' } as typeof routing }, workload),
        ).toBe(true);
      }
    });

    it('admits them with a model matching this server, their consent on and the cloud offering them', () => {
      expect(evaluateAdmission({ ...offered(), workload: MlWorkload.Clip })).toEqual({ admitted: true });
      expect(evaluateAdmission({ ...offered(), workload: MlWorkload.Face })).toEqual({ admitted: true });
    });

    it('refuses each without its own consent', () => {
      expect(refusal({ ...offered({ smartSearch: false, faceRecognition: true }), workload: MlWorkload.Clip })).toBe(
        MlAdmissionRefusal.ConsentMissing,
      );
      expect(refusal({ ...offered({ smartSearch: true }), workload: MlWorkload.Face })).toBe(
        MlAdmissionRefusal.ConsentMissing,
      );
      expect(
        refusal({ ...offered({ smartSearch: false, faceRecognition: true }), workload: MlWorkload.Face }),
      ).toBeNull();
    });

    it("refuses them while no catalogue model matches this server's model, whatever is chosen", () => {
      const base = offered();
      const withLocalModels = (localModels: CloudProbeFacts['localModels']) => ({
        ...base,
        probe: { ...base.probe, cloud: { ...base.probe.cloud, localModels } },
      });
      expect(refusal({ ...withLocalModels({}), workload: MlWorkload.Clip })).toBe(MlAdmissionRefusal.ModelMismatch);
      expect(refusal({ ...withLocalModels({}), workload: MlWorkload.Face, modelId: 'ms_face' })).toBe(
        MlAdmissionRefusal.ModelMismatch,
      );
      // facts stored before FL-455 carry no matches at all
      expect(refusal({ ...withLocalModels(undefined), workload: MlWorkload.Face })).toBe(
        MlAdmissionRefusal.ModelMismatch,
      );
    });

    it('refuses them while the cloud does not offer them, as it does not today', () => {
      expect(refusal({ ...cloud, destination: library, workload: MlWorkload.Clip })).not.toBeNull();
      expect(refusal({ ...cloud, destination: library, workload: MlWorkload.Face })).not.toBeNull();
    });

    it('still refuses text recognition and pet recognition on the cloud', () => {
      const ocr = { ...mlDestinationStub.frameleafCloudConsented, workloads: [MlWorkload.Ocr] };
      expect(refusal({ ...cloud, destination: ocr, workload: MlWorkload.Ocr })).toBe(
        MlAdmissionRefusal.WorkloadNotAllowed,
      );
    });
  });

  it('answers the same through frameleafCloudEligibility as through admission (FL-455, for FL-456)', () => {
    expect(frameleafCloudEligibility({ ...cloud, destination: cloud.destination })).toBeNull();
    expect(
      frameleafCloudEligibility({ ...withFacts({ entitled: false }), destination: cloud.destination }),
    ).toMatchObject({
      refusal: MlAdmissionRefusal.EntitlementMissing,
    });
    expect(frameleafCloudEligibility({ ...cloud, destination: cloud.destination, probe: null })).toMatchObject({
      refusal: MlAdmissionRefusal.DestinationUnhealthy,
    });
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
    expect(refusal({ ...cloud, workload: MlWorkload.RestorationFaithful, modelId: 'restore-faithful' })).toBeNull();
  });

  it('refuses a model whose catalogue group does not match the workload asked for (FL-181 P1, FL-186)', () => {
    // The stub catalogue's `restore-faithful` model is faithful mode: fine for a faithful job, a
    // mismatch for a creative one, even though the model id itself is still "in the catalogue".
    expect(refusal({ ...cloud, workload: MlWorkload.RestorationCreative, modelId: 'restore-faithful' })).toBe(
      MlAdmissionRefusal.ModelMismatch,
    );
    expect(refusal({ ...cloud, workload: MlWorkload.RestorationFaithful, modelId: 'restore-faithful' })).toBeNull();
    // FL-186: every workload runs this check, so a restoration model is never sent for descriptions
    expect(refusal({ ...cloud, workload: MlWorkload.Enrichment, modelId: 'restore-faithful' })).toBe(
      MlAdmissionRefusal.ModelMismatch,
    );
    expect(refusal({ ...cloud, workload: MlWorkload.Enrichment, modelId: 'describe-large' })).toBeNull();
    // facts stored before FL-186 place no model in a group, so they send none until the next check
    expect(
      refusal({ ...withFacts({ modelGroups: undefined }), workload: MlWorkload.Enrichment, modelId: 'describe-large' }),
    ).toBe(MlAdmissionRefusal.ModelMismatch);
  });

  it('admits a cloud job for the nllb-clip, MusicGen-small and Qwen2.5-VL-3B models the catalogue lists (FL-451)', () => {
    for (const modelId of [
      'nllb-clip-base-siglip__mrl',
      'nllb-clip-large-siglip__v1',
      'Xenova/musicgen-small',
      'Qwen/Qwen2.5-VL-3B-Instruct',
      'llmware/qwen2.5-vl-3b-ov',
    ]) {
      const listed = withFacts({
        modelIds: [...facts.modelIds, modelId],
        modelGroups: { ...facts.modelGroups, [modelId]: 'descriptions' },
      });
      expect(refusal({ ...listed, workload: MlWorkload.Enrichment, modelId })).toBeNull();
      // the group check still holds: a listed model is never sent for another group's work
      expect(refusal({ ...listed, modelId })).toBe(MlAdmissionRefusal.ModelMismatch);
    }
  });

  describe("the catalogue's default model (FL-183, FC-34)", () => {
    const verdict = (input: Parameters<typeof evaluateAdmission>[0]) => evaluateAdmission(input);

    it('uses the default of the exact group, restoration by mode, and a routed model over it', () => {
      expect(refusal({ ...cloud, workload: MlWorkload.RestorationFaithful })).toBeNull();
      expect(refusal({ ...cloud, workload: MlWorkload.RestorationCreative })).toBeNull();
      expect(refusal({ ...cloud, workload: MlWorkload.Enrichment })).toBeNull();
      // routed wins even where the catalogue marks another default
      expect(
        refusal({ ...withFacts({ defaultModels: {} }), workload: MlWorkload.Enrichment, modelId: 'describe-large' }),
      ).toBeNull();
    });

    it('refuses unrouted work whose group has no default, asking the administrator to pick', () => {
      const none = verdict({ ...withFacts({ defaultModels: {} }), workload: MlWorkload.RestorationCreative });
      expect(none).toEqual({
        admitted: false,
        refusal: MlAdmissionRefusal.ModelMismatch,
        detail:
          'Frameleaf Cloud: Frameleaf Cloud recommends no model for restoration-creative in this region; choose one in Where each job runs',
      });
      // the faithful default never stands in for creative work
      expect(
        refusal({
          ...withFacts({ defaultModels: { 'restoration-faithful': 'restore-faithful' } }),
          workload: MlWorkload.RestorationCreative,
        }),
      ).toBe(MlAdmissionRefusal.ModelMismatch);
      // facts stored before FL-183 name no default
      expect(refusal({ ...withFacts({ defaultModels: undefined }), workload: MlWorkload.Enrichment })).toBe(
        MlAdmissionRefusal.ModelMismatch,
      );
    });

    it('asks for a Studio AI model of its own, since Studio AI never takes a catalogue default (FL-186)', () => {
      const studioWorkloads = [...cloud.destination.workloads, MlWorkload.StudioAi];
      const { probe } = withFacts({
        modelIds: [...facts.modelIds, 'studio-voice', 'studio-words'],
        modelWorkloads: {
          ...facts.modelWorkloads,
          'studio-voice': MlWorkload.StudioAi,
          'studio-words': MlWorkload.StudioAi,
        },
        modelGroups: { ...facts.modelGroups, 'studio-voice': 'tts', 'studio-words': 'transcription' },
        // even a mark on a Studio AI model's own cloud workload is never taken as its default
        defaultModels: { ...facts.defaultModels, transcription: 'studio-words', tts: 'studio-voice' },
      });
      const studio = {
        ...cloud,
        destination: { ...cloud.destination, workloads: studioWorkloads },
        probe: { ...probe, workloads: studioWorkloads },
        workload: MlWorkload.StudioAi,
      };

      // without a Studio feature there is no model group at all: the job must name it
      expect(evaluateAdmission(studio)).toEqual({
        admitted: false,
        refusal: MlAdmissionRefusal.ModelMismatch,
        detail:
          'Frameleaf Cloud: a Studio AI job must name its Studio feature (speech to text, captions or speech) before Frameleaf Cloud can choose its model',
      });
      expect(evaluateAdmission({ ...studio, studioFeature: 'speech' })).toEqual({
        admitted: false,
        refusal: MlAdmissionRefusal.ModelMismatch,
        detail: 'Frameleaf Cloud: choose a Frameleaf Cloud model for Studio AI speech in Where each job runs',
      });
      expect(evaluateAdmission({ ...studio, modelId: 'studio-voice', studioFeature: 'speech' })).toEqual({
        admitted: true,
      });
      expect(evaluateAdmission({ ...studio, modelId: 'studio-words', studioFeature: 'captions' })).toEqual({
        admitted: true,
      });
      // a speech (TTS) model is never sent for speech to text, and a Studio AI job names its feature
      expect(evaluateAdmission({ ...studio, modelId: 'studio-voice', studioFeature: 'speech-to-text' })).toMatchObject({
        admitted: false,
        refusal: MlAdmissionRefusal.ModelMismatch,
      });
      expect(evaluateAdmission({ ...studio, modelId: 'studio-voice' })).toMatchObject({
        admitted: false,
        refusal: MlAdmissionRefusal.ModelMismatch,
      });
    });

    it('refuses a default the catalogue no longer lists, or one of the other mode', () => {
      expect(
        refusal({ ...withFacts({ defaultModels: { descriptions: 'gone' } }), workload: MlWorkload.Enrichment }),
      ).toBe(MlAdmissionRefusal.ModelMismatch);
      expect(
        refusal({
          ...withFacts({ defaultModels: { 'restoration-creative': 'restore-faithful' } }),
          workload: MlWorkload.RestorationCreative,
        }),
      ).toBe(MlAdmissionRefusal.ModelMismatch);
    });
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
  it.each([MlWorkload.Clip, MlWorkload.Ocr, MlWorkload.Face])(
    'admits an authorized %s desktop pool before probing an unavailable NAS backend and keeps accounting',
    async (workload) => {
      const d = deps({ probe: { ...mlProbeStub.healthy, reachable: false } });
      const desktop = vi.fn();
      const property =
        workload === MlWorkload.Clip ? 'desktopClip' : workload === MlWorkload.Ocr ? 'desktopOcr' : 'desktopFace';
      const selectBackgroundPool = vi.fn((selection: MlSelection) =>
        Promise.resolve({ ...selection, [property]: desktop }),
      );
      const chosen = await selectMlDestination(
        { ...d, selectBackgroundPool },
        { workload, destinationId: mlDestinationStub.local.id, jobId: 'queued-job' },
      );
      expect(chosen[property]).toBe(desktop);
      expect(selectBackgroundPool).toHaveBeenCalledOnce();
      expect(d.machineLearningRepository.probe).not.toHaveBeenCalled();
      expect(d.mlDestinationRepository.recordProbe).not.toHaveBeenCalled();
      await chosen.endpoint.assertAuthority!();
      expect(d.mlDestinationRepository.assertRecoveryAuthority).toHaveBeenCalledTimes(3);
      chosen.record({ bytesSent: 1, bytesReceived: 2, durationMs: 3, outcome: 'success' });
      expect(d.mlDestinationRepository.recordAccounting).toHaveBeenCalledWith(
        expect.objectContaining({ destinationId: mlDestinationStub.local.id, jobId: 'queued-job', costUsd: null }),
      );
    },
  );

  it.each([{ enabled: false }, { workloads: [] }, { budgetLimitUsd: 0 }, { url: null }])(
    'refuses static permission failure %j before desktop pool selection',
    async (patch) => {
      const destination = { ...mlDestinationStub.local, ...patch };
      const d = deps({ destination });
      const selectBackgroundPool = vi.fn();
      await expect(
        selectMlDestination(
          { ...d, selectBackgroundPool },
          {
            workload: MlWorkload.Clip,
            destinationId: destination.id,
          },
        ),
      ).rejects.toBeInstanceOf(MlDestinationRefusedError);
      expect(selectBackgroundPool).not.toHaveBeenCalled();
      expect(d.machineLearningRepository.probe).not.toHaveBeenCalled();
    },
  );

  it('keeps ordinary backend health admission when no desktop pool is selected', async () => {
    const d = deps({ probe: { ...mlProbeStub.healthy, reachable: false } });
    const selectBackgroundPool = vi.fn((selection: MlSelection) => Promise.resolve(selection));
    await expect(
      selectMlDestination(
        { ...d, selectBackgroundPool },
        {
          workload: MlWorkload.Clip,
          destinationId: mlDestinationStub.local.id,
        },
      ),
    ).rejects.toThrow('destination-unhealthy');
    expect(selectBackgroundPool).toHaveBeenCalledOnce();
    expect(d.machineLearningRepository.probe).toHaveBeenCalledOnce();
  });

  it('propagates desktop pool authority refusal without probing or falling back', async () => {
    const d = deps({});
    const selectBackgroundPool = vi.fn().mockRejectedValue(new Error('desktop_pool_policy_changed'));
    await expect(
      selectMlDestination(
        { ...d, selectBackgroundPool },
        {
          workload: MlWorkload.Clip,
          destinationId: mlDestinationStub.local.id,
        },
      ),
    ).rejects.toThrow('desktop_pool_policy_changed');
    expect(d.machineLearningRepository.probe).not.toHaveBeenCalled();
  });

  it('keeps other workloads on ordinary backend admission', async () => {
    const d = deps({});
    const selectBackgroundPool = vi.fn();
    await selectMlDestination(
      { ...d, selectBackgroundPool },
      {
        workload: MlWorkload.Enrichment,
        destinationId: mlDestinationStub.local.id,
      },
    );
    expect(selectBackgroundPool).not.toHaveBeenCalled();
    expect(d.machineLearningRepository.probe).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'checks consent during created-job readmission despite a spent budget (stale: %s)',
    async (stale) => {
      const destination = {
        ...mlDestinationStub.frameleafCloudConsented,
        budgetLimitUsd: 0,
        consentVersion: stale ? 'old-consent' : mlDestinationStub.frameleafCloudConsented.consentVersion,
      };
      const d = deps({ destination, probe: mlProbeStub.frameleafCloud });
      const selection = selectMlDestination(d, {
        workload: MlWorkload.Enrichment,
        destinationId: destination.id,
        createdCloudJob: true,
      });

      if (stale) {
        await expect(selection).rejects.toMatchObject({ refusal: MlAdmissionRefusal.ConsentVersionOutdated });
      } else {
        await expect(selection).resolves.toMatchObject({ destinationId: destination.id });
      }
      expect(d.machineLearningRepository.probe).toHaveBeenCalledWith(expect.anything(), { maxAgeMs: 0 });
      expect(d.mlDestinationRepository.getSpend).not.toHaveBeenCalled();
    },
  );

  it('keeps spending limits for new admissions alongside created-job readmission', async () => {
    const destination = { ...mlDestinationStub.frameleafCloudConsented, budgetLimitUsd: 0 };
    const d = deps({ destination, probe: mlProbeStub.frameleafCloud });

    await expect(
      selectMlDestination(d, { workload: MlWorkload.Enrichment, destinationId: destination.id }),
    ).rejects.toMatchObject({ refusal: MlAdmissionRefusal.BudgetExceeded });
    expect(d.machineLearningRepository.probe).not.toHaveBeenCalled();
  });

  it('keeps local spending limits when a caller requests created-job readmission', async () => {
    const destination = { ...mlDestinationStub.local, budgetLimitUsd: 0 };
    const d = deps({ destination });

    await expect(
      selectMlDestination(d, { workload: MlWorkload.Face, destinationId: destination.id, createdCloudJob: true }),
    ).rejects.toMatchObject({ refusal: MlAdmissionRefusal.BudgetExceeded });
    expect(d.machineLearningRepository.probe).not.toHaveBeenCalled();
  });

  it.each([0, 1000])('does not persist a local observation already recorded or superseded (%i ms)', async (age) => {
    const d = deps({
      destination: {
        ...mlDestinationStub.local,
        lastProbeAt: new Date(mlProbeStub.healthy.probedAt.getTime() + age),
      },
    });
    await selectMlDestination(d, { workload: MlWorkload.Face, destinationId: mlDestinationStub.local.id });
    expect(d.machineLearningRepository.probe).toHaveBeenCalledTimes(1);
    expect(d.mlDestinationRepository.recordProbe).not.toHaveBeenCalled();
  });

  it('persists a fresh observation and retries persistence after a database failure', async () => {
    const d = deps({ destination: { ...mlDestinationStub.local, lastProbeAt: null } });
    vi.mocked(d.mlDestinationRepository.recordProbe).mockRejectedValueOnce(new Error('database unavailable'));
    const request = { workload: MlWorkload.Face, destinationId: mlDestinationStub.local.id };
    await expect(selectMlDestination(d, request)).rejects.toThrow('database unavailable');
    await expect(selectMlDestination(d, request)).resolves.toMatchObject({ kind: MlDestinationKind.Local });
    expect(d.mlDestinationRepository.recordProbe).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a cached Cloud consent version for current admission (FL-201)', async () => {
    const d = deps({ destination: mlDestinationStub.frameleafCloudConsented, probe: mlProbeStub.frameleafCloud });
    vi.mocked(d.machineLearningRepository.probe).mockImplementation((_endpoint, options) =>
      Promise.resolve(
        options?.maxAgeMs === 0
          ? {
              ...mlProbeStub.frameleafCloud,
              cloud: { ...mlProbeStub.frameleafCloud.cloud!, consentRequiredVersion: '2026-10-01.1' },
            }
          : mlProbeStub.frameleafCloud,
      ),
    );
    await expect(
      selectMlDestination(d, {
        workload: MlWorkload.Enrichment,
        destinationId: mlDestinationStub.frameleafCloudConsented.id,
      }),
    ).rejects.toMatchObject({ refusal: MlAdmissionRefusal.ConsentVersionOutdated });
  });

  it('refuses Frameleaf Cloud before any check while processing is off or the work stays here (FL-163)', async () => {
    const routing = {
      descriptions: 'both',
      upscale: 'local',
      restoration: 'local',
      studio: 'local',
      interpolation: 'local',
    } as const;
    const request = { workload: MlWorkload.Enrichment, destinationId: mlDestinationStub.frameleafCloudConsented.id };

    const off = deps({ destination: mlDestinationStub.frameleafCloudConsented, probe: mlProbeStub.frameleafCloud });
    await expect(
      selectMlDestination({ ...off, cloudMlSettings: () => Promise.resolve({ enabled: false, routing }) }, request),
    ).rejects.toMatchObject({ refusal: MlAdmissionRefusal.CloudUnavailable });
    expect(off.machineLearningRepository.probe).not.toHaveBeenCalled();

    const local = deps({ destination: mlDestinationStub.frameleafCloudConsented, probe: mlProbeStub.frameleafCloud });
    await expect(
      selectMlDestination(
        {
          ...local,
          cloudMlSettings: () => Promise.resolve({ enabled: true, routing: { ...routing, descriptions: 'local' } }),
        },
        request,
      ),
    ).rejects.toMatchObject({ refusal: MlAdmissionRefusal.WorkloadNotAllowed });
    expect(local.machineLearningRepository.probe).not.toHaveBeenCalled();

    const on = deps({ destination: mlDestinationStub.frameleafCloudConsented, probe: mlProbeStub.frameleafCloud });
    await expect(
      selectMlDestination({ ...on, cloudMlSettings: () => Promise.resolve({ enabled: true, routing }) }, request),
    ).resolves.toMatchObject({ kind: MlDestinationKind.FrameleafCloud });
  });

  it('admits Frameleaf Cloud through its delegated check and records the cloud facts (FL-159)', async () => {
    // Downstream model/accounting mechanics only, not current workload disclosure qualification.
    vi.spyOn(cloudDisclosure, 'hasPendingCloudDisclosure').mockReturnValue(false);
    const d = deps({ destination: mlDestinationStub.frameleafCloudConsented, probe: mlProbeStub.frameleafCloud });
    const selection = await selectMlDestination(d, {
      workload: MlWorkload.RestorationFaithful,
      destinationId: mlDestinationStub.frameleafCloudConsented.id,
    });
    expect(selection.endpoint).toMatchObject(FRAMELEAF_CLOUD_ENDPOINT);
    expect(d.machineLearningRepository.probe).toHaveBeenCalledWith(expect.objectContaining(FRAMELEAF_CLOUD_ENDPOINT), {
      maxAgeMs: expect.any(Number),
    });
    expect(d.mlDestinationRepository.recordProbe).toHaveBeenCalledWith(
      mlDestinationStub.frameleafCloudConsented.id,
      expect.objectContaining({ cloud: mlProbeStub.frameleafCloud.cloud }),
      mlDestinationStub.frameleafCloudConsented,
    );
  });

  it("names the catalogue's marked default when no model is routed, never a model name (FL-146, FL-183)", async () => {
    // Downstream model/accounting mechanics only, not current workload disclosure qualification.
    vi.spyOn(cloudDisclosure, 'hasPendingCloudDisclosure').mockReturnValue(false);
    const d = deps({ destination: mlDestinationStub.frameleafCloudConsented, probe: mlProbeStub.frameleafCloud });
    const cloud = await selectMlDestination(d, {
      workload: MlWorkload.Enrichment,
      destinationId: mlDestinationStub.frameleafCloudConsented.id,
    });
    expect(cloud.cloudModelId).toBe('describe-large');
    const creative = await selectMlDestination(d, {
      workload: MlWorkload.RestorationCreative,
      destinationId: mlDestinationStub.frameleafCloudConsented.id,
    });
    expect(creative.cloudModelId).toBe('restore-creative');
    const local = await selectMlDestination(deps({}), {
      workload: MlWorkload.Enrichment,
      destinationId: 'ml-destination-local',
    });
    expect(local.cloudModelId).toBeNull();
  });

  it('refuses the chosen model when the catalogue dropped it, and never picks another (FL-159)', async () => {
    const d = deps({
      destination: mlDestinationStub.frameleafCloudConsented,
      probe: mlProbeStub.frameleafCloud,
      choices: { descriptions: 'retired-model' },
    });
    const error = await selectMlDestination(d, {
      workload: MlWorkload.Enrichment,
      destinationId: mlDestinationStub.frameleafCloudConsented.id,
    }).catch((error_) => error_);
    expect((error as MlDestinationRefusedError).refusal).toBe(MlAdmissionRefusal.ModelMismatch);
  });

  it('sends the chosen cloud model whatever the route points at, and reads it per model group (FL-186)', async () => {
    // Downstream model/accounting mechanics only, not current workload disclosure qualification.
    vi.spyOn(cloudDisclosure, 'hasPendingCloudDisclosure').mockReturnValue(false);
    // A "Both" workload routed to this server: a job the person sends to the cloud still names the
    // model chosen for its group. The route is never read for the model.
    const d = deps({
      destination: mlDestinationStub.frameleafCloudConsented,
      probe: mlProbeStub.frameleafCloud,
      route: { workload: MlWorkload.RestorationCreative, destinationId: 'ml-destination-local' },
      choices: { 'restoration-creative': 'restore-creative', descriptions: 'describe-large' },
    });
    const creative = await selectMlDestination(d, {
      workload: MlWorkload.RestorationCreative,
      destinationId: mlDestinationStub.frameleafCloudConsented.id,
    });
    expect(creative.cloudModelId).toBe('restore-creative');
    expect(d.mlDestinationRepository.getCloudModelChoice).toHaveBeenCalledWith('restoration-creative');
    expect(d.mlDestinationRepository.getRoute).not.toHaveBeenCalled();

    // a local destination never reads a cloud model
    const local = deps({ choices: { descriptions: 'describe-large' } });
    await selectMlDestination(local, { workload: MlWorkload.Enrichment, destinationId: 'ml-destination-local' });
    expect(local.mlDestinationRepository.getCloudModelChoice).not.toHaveBeenCalled();
  });

  it('uses the Studio AI transcription or speech choice by feature, and refuses a model of the other one (FL-186)', async () => {
    expect(vi.isMockFunction(cloudDisclosure.hasPendingCloudDisclosure)).toBe(false);
    const workloads = [...mlDestinationStub.frameleafCloudConsented.workloads, MlWorkload.StudioAi];
    const destination = { ...mlDestinationStub.frameleafCloudConsented, workloads };
    const facts = mlProbeStub.frameleafCloud.cloud!;
    const probe = {
      ...mlProbeStub.frameleafCloud,
      workloads,
      cloud: {
        ...facts,
        modelIds: [...facts.modelIds, 'studio-voice', 'studio-words'],
        modelGroups: { ...facts.modelGroups, 'studio-voice': 'tts', 'studio-words': 'transcription' },
      },
    };
    const d = deps({ destination, probe, choices: { transcription: 'studio-words', tts: 'studio-voice' } });
    const request = { workload: MlWorkload.StudioAi, destinationId: destination.id };

    await expect(selectMlDestination(d, { ...request, studioFeature: 'captions' })).resolves.toMatchObject({
      cloudModelId: 'studio-words',
    });
    await expect(selectMlDestination(d, { ...request, studioFeature: 'speech' })).resolves.toMatchObject({
      cloudModelId: 'studio-voice',
    });

    // a TTS model chosen for transcription is refused at admission, never sent for speech to text
    const wrong = deps({ destination, probe, choices: { transcription: 'studio-voice' } });
    const error = await selectMlDestination(wrong, { ...request, studioFeature: 'speech-to-text' }).catch(
      (error_) => error_,
    );
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
    expect(d.machineLearningRepository.probe).toHaveBeenCalledWith(expect.objectContaining(endpoint), {
      maxAgeMs: expect.any(Number),
      includeHardware: false,
    });
    expect(d.mlDestinationRepository.recordProbe).not.toHaveBeenCalled();

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
    const d = deps({
      probe: {
        ...mlProbeStub.unreachable,
        probedAt: new Date(mlProbeStub.unreachable.probedAt.getTime() + 1),
      },
    });
    const error = await selectMlDestination(d, {
      workload: MlWorkload.Face,
      destinationId: 'ml-destination-local',
    }).catch((error_) => error_);
    expect((error as MlDestinationRefusedError).refusal).toBe(MlAdmissionRefusal.DestinationUnhealthy);
    expect(d.mlDestinationRepository.recordProbe).toHaveBeenCalledWith(
      'ml-destination-local',
      expect.objectContaining({ health: MlDestinationHealth.Unhealthy, workloads: null }),
      mlDestinationStub.local,
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

  it('lets Frameleaf Cloud mix only the workloads it can run, smart search and faces included (FL-159, FL-455)', () => {
    expect(
      workloadPolicyProblem(MlDestinationKind.FrameleafCloud, [MlWorkload.Enrichment, MlWorkload.RestorationCreative]),
    ).toBeNull();
    expect(workloadPolicyProblem(MlDestinationKind.FrameleafCloud, [MlWorkload.Face])).toBeNull();
    expect(workloadPolicyProblem(MlDestinationKind.FrameleafCloud, [MlWorkload.Clip])).toBeNull();
    expect(workloadPolicyProblem(MlDestinationKind.FrameleafCloud, [MlWorkload.Clip, MlWorkload.Ocr])).toMatch(
      /ocr stays/,
    );
    expect(workloadPolicyProblem(MlDestinationKind.FrameleafCloud, [MlWorkload.PetRecognition])).toMatch(
      /pet-recognition stays/,
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
    const sameUrl = { ...mlDestinationStub.lan, url: 'http://frameleaf-machine-learning:3003/' };
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

  it('keeps the restoration models a worker reported, available only with verified weights and a qualification (FL-423)', () => {
    const capability = {
      family: 'realbasicvsr',
      mode: AssetRestorationMode.Faithful,
      displayName: 'RealBasicVSR x4',
      fingerprint: 'a'.repeat(64),
      qualificationId: 'q-1',
      state: RestorationModelState.Available,
    };
    const models = restorationModelsFromReport([
      { ...capability, id: 'realbasicvsr-x4' },
      { ...capability, id: 'unverified', fingerprint: null },
      { ...capability, id: 'unqualified', qualificationId: null },
      { ...capability, id: 'missing', state: RestorationModelState.WeightsMissing },
    ]);
    expect(models).toEqual([
      { id: 'realbasicvsr-x4', family: 'realbasicvsr', mode: 'faithful', name: 'RealBasicVSR x4', available: true },
      { id: 'unverified', family: 'realbasicvsr', mode: 'faithful', name: 'RealBasicVSR x4', available: false },
      { id: 'unqualified', family: 'realbasicvsr', mode: 'faithful', name: 'RealBasicVSR x4', available: false },
      { id: 'missing', family: 'realbasicvsr', mode: 'faithful', name: 'RealBasicVSR x4', available: false },
    ]);

    // a CPU-only worker with models still keeps them, beside the facts it reported
    const kept = hardwareFromProbe({ reachable: true, hardware: null }, [], models);
    expect(kept).toMatchObject({ gpus: [], restorationModels: models });
    expect(storedRestorationModels(kept)).toEqual(models);
    expect(storedRestorationModels(cpuHardware)).toEqual([]);
    expect(storedRestorationModels(null)).toEqual([]);
    expect(hardwareFromProbe({ reachable: false, hardware: null }, [], models)).toBeNull();
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

describe('storedAdmission downstream model mechanics (workload-policy mocked; not disclosure qualification)', () => {
  beforeEach(() => vi.spyOn(cloudDisclosure, 'hasPendingCloudDisclosure').mockReturnValue(false));
  const facts = mlDestinationStub.frameleafCloudConsented.lastProbeCloud!;
  const cloudWith = (
    overrides: Partial<typeof facts>,
    workloads = mlDestinationStub.frameleafCloudConsented.workloads,
  ) => ({
    ...mlDestinationStub.frameleafCloudConsented,
    workloads,
    lastProbeWorkloads: workloads,
    lastProbeCloud: { ...facts, ...overrides },
  });

  it('judges the stored check with the model chosen for the group, as a job would name it', () => {
    const destination = cloudWith({ defaultModels: {} });
    expect(storedAdmission({ destination, workload: MlWorkload.Enrichment, spentUsd: 0, choices: {} })).toMatchObject({
      admitted: false,
      refusal: MlAdmissionRefusal.ModelMismatch,
    });
    expect(
      storedAdmission({
        destination,
        workload: MlWorkload.Enrichment,
        spentUsd: 0,
        choices: { descriptions: 'describe-large' },
      }),
    ).toEqual({ admitted: true });
    // a chosen model of the other mode is refused, never sent
    expect(
      storedAdmission({
        destination,
        workload: MlWorkload.RestorationCreative,
        spentUsd: 0,
        choices: { 'restoration-creative': 'restore-faithful' },
      }),
    ).toMatchObject({ admitted: false, refusal: MlAdmissionRefusal.ModelMismatch });
  });

  it('counts Studio AI only when both speech to text and speech have a model, and names the missing one', () => {
    const workloads = [MlWorkload.StudioAi];
    const destination = cloudWith(
      {
        modelIds: [...facts.modelIds, 'studio-words', 'studio-voice'],
        modelGroups: { ...facts.modelGroups, 'studio-words': 'transcription', 'studio-voice': 'tts' },
      },
      workloads,
    );
    const studio = (choices: Record<string, string>) =>
      storedAdmission({ destination, workload: MlWorkload.StudioAi, spentUsd: 0, choices });

    expect(studio({ tts: 'studio-voice' })).toEqual({
      admitted: false,
      refusal: MlAdmissionRefusal.ModelMismatch,
      detail:
        'Frameleaf Cloud: choose a Frameleaf Cloud model for Studio AI speech to text and captions in Where each job runs',
    });
    expect(studio({ transcription: 'studio-words' })).toMatchObject({
      detail: 'Frameleaf Cloud: choose a Frameleaf Cloud model for Studio AI speech in Where each job runs',
    });
    expect(studio({ transcription: 'studio-words', tts: 'studio-voice' })).toEqual({ admitted: true });
    // a named feature is judged on its own group only
    expect(
      storedAdmission({
        destination,
        workload: MlWorkload.StudioAi,
        spentUsd: 0,
        choices: { tts: 'studio-voice' },
        studioFeature: 'speech',
      }),
    ).toEqual({ admitted: true });
  });

  it('shows a check from before model groups as waiting for the next one, and reads old group keys', () => {
    // no modelGroups: a view cannot tell whether there is a model to send, so it waits (a transient
    // refusal) whether or not a model is chosen; a live admission checks again first
    const unplaced = cloudWith({ modelGroups: undefined, defaultModels: {} });
    const waiting = {
      admitted: false,
      refusal: MlAdmissionRefusal.DestinationUnhealthy,
      detail: 'Frameleaf Cloud: checked before model groups; waiting for the next check',
    };
    expect(
      storedAdmission({ destination: unplaced, workload: MlWorkload.Enrichment, spentUsd: 0, choices: {} }),
    ).toEqual(waiting);
    expect(
      storedAdmission({
        destination: unplaced,
        workload: MlWorkload.Enrichment,
        spentUsd: 0,
        choices: { descriptions: 'describe-large' },
      }),
    ).toEqual(waiting);
    const studio = cloudWith({ modelGroups: undefined }, [MlWorkload.StudioAi]);
    expect(storedAdmission({ destination: studio, workload: MlWorkload.StudioAi, spentUsd: 0, choices: {} })).toEqual(
      waiting,
    );

    // a default recorded under the old `restoration:faithful` key is still found
    const oldKeys = cloudWith({
      defaultModels: { 'restoration:faithful': 'restore-faithful' },
      modelGroups: { 'restore-faithful': 'restoration:faithful' },
    });
    expect(storedProbe(oldKeys)?.cloud).toMatchObject({
      defaultModels: { 'restoration-faithful': 'restore-faithful' },
      modelGroups: { 'restore-faithful': 'restoration-faithful' },
    });
    expect(
      storedAdmission({ destination: oldKeys, workload: MlWorkload.RestorationFaithful, spentUsd: 0, choices: {} }),
    ).toEqual({ admitted: true });
  });

  it('reads the chosen models only when a Frameleaf Cloud destination is listed', async () => {
    const repository = {
      getCloudModelChoices: vi
        .fn()
        .mockResolvedValue([{ modelGroup: 'tts', modelId: 'studio-voice', updatedAt: new Date() }]),
    };
    await expect(readCloudModelChoices(repository, [mlDestinationStub.local])).resolves.toEqual({});
    expect(repository.getCloudModelChoices).not.toHaveBeenCalled();
    await expect(
      readCloudModelChoices(repository, [mlDestinationStub.local, mlDestinationStub.frameleafCloudConsented]),
    ).resolves.toEqual({ tts: 'studio-voice' });
  });
});

describe('FL-286 approved Cloud workload disclosure', () => {
  it.each([
    MlWorkload.RestorationFaithful,
    MlWorkload.RestorationCreative,
    MlWorkload.Upscale,
    MlWorkload.Interpolation,
  ])('admits %s only with current consent and administrator opt-in', async (workload) => {
    expect(vi.isMockFunction(cloudDisclosure.hasPendingCloudDisclosure)).toBe(false);
    const destination = {
      ...mlDestinationStub.frameleafCloudConsented,
      consentVersion: '2026-09-26.1',
      workloads: [workload],
    };
    const group = workload;
    const probe = {
      ...mlProbeStub.frameleafCloud,
      workloads: [workload],
      cloud: {
        ...mlProbeStub.frameleafCloud.cloud!,
        consentRequiredVersion: '2026-09-26.1',
        modelIds: ['fixture-model'],
        modelGroups: { 'fixture-model': group },
        defaultModels: { [group]: 'fixture-model' },
      },
    };
    const d = deps({ destination, probe });
    await expect(selectMlDestination(d, { workload, destinationId: destination.id })).resolves.toMatchObject({
      kind: MlDestinationKind.FrameleafCloud,
      cloudModelId: 'fixture-model',
    });
    expect(d.machineLearningRepository.probe).toHaveBeenCalledOnce();
    expect(d.mlDestinationRepository.recordProbe).toHaveBeenCalledOnce();

    const input = { destination, workload, endpoint: FRAMELEAF_CLOUD_ENDPOINT, probe, spentUsd: 0 };
    expect(evaluateAdmission(input)).toEqual({ admitted: true });
    expect(
      storedAdmission({
        destination: { ...destination, lastProbeWorkloads: [workload], lastProbeCloud: probe.cloud },
        workload,
        spentUsd: 0,
        choices: {},
      }),
    ).toEqual({ admitted: true });
    expect(evaluateAdmission({ ...input, destination: { ...destination, consentAcknowledgedAt: null } })).toMatchObject(
      { admitted: false, refusal: MlAdmissionRefusal.ConsentMissing },
    );
    expect(evaluateAdmission({ ...input, destination: { ...destination, consentVersion: 'stale' } })).toMatchObject({
      admitted: false,
      refusal: MlAdmissionRefusal.ConsentVersionOutdated,
    });
    expect(evaluateAdmission({ ...input, destination: { ...destination, enabled: false } })).toMatchObject({
      admitted: false,
      refusal: MlAdmissionRefusal.DestinationDisabled,
    });
    expect(evaluateAdmission({ ...input, destination: { ...destination, workloads: [] } })).toMatchObject({
      admitted: false,
      refusal: MlAdmissionRefusal.WorkloadNotAllowed,
    });
  });
});

describe('FL-201 real disclosure policy and approved workloads', () => {
  it('keeps pending disclosure terminal for created jobs and unsupported workloads pending', () => {
    expect(cloudDisclosure.hasPendingCloudDisclosure(MlWorkload.Ocr)).toBe(true);
    expect(STOPS_CREATED_CLOUD_JOB.has(MlAdmissionRefusal.DisclosurePending)).toBe(true);
    expect(STOPS_CREATED_CLOUD_JOB.has(MlAdmissionRefusal.WalletInsufficient)).toBe(false);
  });

  it('retains real missing, stale and current consent checks for approved description', () => {
    expect(vi.isMockFunction(cloudDisclosure.hasPendingCloudDisclosure)).toBe(false);
    const input = {
      destination: mlDestinationStub.frameleafCloudConsented,
      workload: MlWorkload.Enrichment,
      endpoint: FRAMELEAF_CLOUD_ENDPOINT,
      probe: mlProbeStub.frameleafCloud,
      spentUsd: 0,
    };
    expect(evaluateAdmission(input)).toEqual({ admitted: true });
    expect(
      evaluateAdmission({ ...input, destination: { ...input.destination, consentAcknowledgedAt: null } }),
    ).toMatchObject({ admitted: false, refusal: MlAdmissionRefusal.ConsentMissing });
    expect(
      evaluateAdmission({ ...input, destination: { ...input.destination, consentVersion: 'stale' } }),
    ).toMatchObject({ admitted: false, refusal: MlAdmissionRefusal.ConsentVersionOutdated });
  });
});

describe('clipTextDestinationId (FL-455)', () => {
  const repository = (routedTo: typeof mlDestinationStub.local, rows = [mlDestinationStub.local]) =>
    ({
      getRoute: vi.fn().mockResolvedValue({ workload: MlWorkload.Clip, destinationId: routedTo.id }),
      getById: vi.fn().mockResolvedValue(routedTo),
      getAll: vi.fn().mockResolvedValue(rows),
    }) as unknown as MlDestinationRepository;

  it('encodes search text where smart search is routed when that is at home', async () => {
    await expect(clipTextDestinationId(repository(mlDestinationStub.lan))).resolves.toBe(mlDestinationStub.lan.id);
  });

  it("keeps search text on this server's machine learning when smart search is routed to Frameleaf Cloud", async () => {
    const cloud = mlDestinationStub.frameleafCloudConsented;
    await expect(
      clipTextDestinationId(repository(cloud, [cloud, mlDestinationStub.lan, mlDestinationStub.local])),
    ).resolves.toBe(mlDestinationStub.local.id);
  });

  it('refuses rather than send search text to the cloud when this server has no machine learning on', async () => {
    const cloud = mlDestinationStub.frameleafCloudConsented;
    await expect(clipTextDestinationId(repository(cloud, [cloud]))).rejects.toBeInstanceOf(MlDestinationRefusedError);
  });
});

describe('home-only selection (FL-455)', () => {
  it('refuses Frameleaf Cloud for work that never leaves this network, before anything is checked', async () => {
    const { mlDestinationRepository, machineLearningRepository } = deps({
      destination: mlDestinationStub.frameleafCloudConsented,
    });
    await expect(
      selectMlDestination(
        { mlDestinationRepository, machineLearningRepository },
        {
          workload: MlWorkload.Clip,
          destinationId: mlDestinationStub.frameleafCloudConsented.id,
          homeOnly: true,
        },
      ),
    ).rejects.toMatchObject({ refusal: MlAdmissionRefusal.WorkloadNotAllowed });
    expect(machineLearningRepository.probe).not.toHaveBeenCalled();
  });
});
