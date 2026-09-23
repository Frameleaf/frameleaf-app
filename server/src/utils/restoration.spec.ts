import { describe, expect, it, vi } from 'vitest';
import {
  RestorationDynamicRange,
  RestorationMode,
  RestorationModelCapability,
  RestorationModelState,
} from 'src/dtos/restoration-inference.dto.js';
import { MlAdmissionRefusal, MlDestinationKind, MlWorkload } from 'src/enum.js';
import type { MachineLearningRepository, MlEndpointProbe } from 'src/repositories/machine-learning.repository.js';
import type { MlDestinationRepository, MlDestinationRow } from 'src/repositories/ml-destination.repository.js';
import { MlDestinationRefusedError } from 'src/utils/ml-destination.js';
import {
  chooseRestorationModel,
  estimateRestorationSeconds,
  restorationTargetGeometry,
  restorationWorkload,
  selectRestorationDestination,
} from 'src/utils/restoration.js';
import { mlDestinationStub, mlProbeStub } from 'test/fixtures/ml-destination.stub.js';

const runPodEndpoint = { url: 'https://pod.proxy.runpod.net/', authToken: 'rpa_test_key' };

const deps = (overrides: {
  destination?: MlDestinationRow;
  probe?: MlEndpointProbe;
  route?: { workload: MlWorkload; destinationId: string };
  runPod?: { url: string; authToken?: string } | null;
}) => {
  const destination = overrides.destination ?? mlDestinationStub.lan;
  const find = (id: string) => Promise.resolve(id === destination.id ? destination : undefined);
  const mlDestinationRepository = {
    getById: vi.fn().mockImplementation(find),
    getSpend: vi.fn().mockResolvedValue(0),
    recordProbe: vi.fn().mockResolvedValue(undefined),
    recordAccounting: vi.fn().mockResolvedValue(undefined),
    getRoute: vi.fn().mockResolvedValue(overrides.route),
  } as unknown as MlDestinationRepository;
  const machineLearningRepository = {
    probe: vi.fn().mockResolvedValue(overrides.probe ?? mlProbeStub.restoration),
    getRunPodEndpoint: vi.fn().mockReturnValue(overrides.runPod ?? null),
  } as unknown as MachineLearningRepository;
  return { mlDestinationRepository, machineLearningRepository };
};

const refusalOf = async (promise: Promise<unknown>) => {
  const error = await promise.catch((error_: unknown) => error_);
  expect(error).toBeInstanceOf(MlDestinationRefusedError);
  return (error as MlDestinationRefusedError).refusal;
};

describe('restorationWorkload', () => {
  it('maps each mode to its own workload', () => {
    expect(restorationWorkload(RestorationMode.Faithful)).toBe(MlWorkload.RestorationFaithful);
    expect(restorationWorkload(RestorationMode.Creative)).toBe(MlWorkload.RestorationCreative);
  });
});

describe('selectRestorationDestination', () => {
  it('admits the LAN worker the person chose for the mode', async () => {
    const d = deps({});

    const selection = await selectRestorationDestination(d, {
      mode: RestorationMode.Faithful,
      destinationId: mlDestinationStub.lan.id,
      acknowledgeCloudUpload: false,
      jobId: 'operation-1',
    });

    expect(selection).toMatchObject({
      destinationId: mlDestinationStub.lan.id,
      kind: MlDestinationKind.Lan,
      workload: MlWorkload.RestorationFaithful,
    });
    expect(d.machineLearningRepository.probe).toHaveBeenCalledTimes(1);
  });

  it('uses the administrator route when the person made no choice', async () => {
    const d = deps({ route: { workload: MlWorkload.RestorationFaithful, destinationId: mlDestinationStub.lan.id } });

    const selection = await selectRestorationDestination(d, {
      mode: RestorationMode.Faithful,
      destinationId: null,
      acknowledgeCloudUpload: false,
    });

    expect(selection.destinationId).toBe(mlDestinationStub.lan.id);
    expect(d.mlDestinationRepository.getRoute).toHaveBeenCalledWith(MlWorkload.RestorationFaithful);
  });

  it('refuses when there is neither a choice nor a route', async () => {
    const d = deps({});
    const request = { mode: RestorationMode.Creative, destinationId: null, acknowledgeCloudUpload: false };

    expect(await refusalOf(selectRestorationDestination(d, request))).toBe(MlAdmissionRefusal.WorkloadNotRouted);
    expect(d.machineLearningRepository.probe).not.toHaveBeenCalled();
  });

  it('never contacts a cloud destination until the person confirms the upload', async () => {
    const d = deps({ destination: mlDestinationStub.runPodConsented, runPod: runPodEndpoint });
    const request = {
      mode: RestorationMode.Creative,
      destinationId: mlDestinationStub.runPodConsented.id,
      acknowledgeCloudUpload: false,
    };

    expect(await refusalOf(selectRestorationDestination(d, request))).toBe(MlAdmissionRefusal.ConsentMissing);
    expect(d.machineLearningRepository.probe).not.toHaveBeenCalled();
  });

  it('also refuses a routed cloud destination without the confirmation', async () => {
    const d = deps({
      destination: mlDestinationStub.runPodConsented,
      runPod: runPodEndpoint,
      route: { workload: MlWorkload.RestorationCreative, destinationId: mlDestinationStub.runPodConsented.id },
    });
    const request = { mode: RestorationMode.Creative, destinationId: null, acknowledgeCloudUpload: false };

    expect(await refusalOf(selectRestorationDestination(d, request))).toBe(MlAdmissionRefusal.ConsentMissing);
    expect(d.machineLearningRepository.probe).not.toHaveBeenCalled();
  });

  it('still needs the administrator consent when the person confirms the upload', async () => {
    const d = deps({ destination: mlDestinationStub.runPod, runPod: runPodEndpoint });
    const request = {
      mode: RestorationMode.Creative,
      destinationId: mlDestinationStub.runPod.id,
      acknowledgeCloudUpload: true,
    };

    expect(await refusalOf(selectRestorationDestination(d, request))).toBe(MlAdmissionRefusal.ConsentMissing);
    expect(d.machineLearningRepository.probe).not.toHaveBeenCalled();
  });

  it('admits a consented cloud destination once the person confirms the upload', async () => {
    const d = deps({ destination: mlDestinationStub.runPodConsented, runPod: runPodEndpoint });

    const selection = await selectRestorationDestination(d, {
      mode: RestorationMode.Creative,
      destinationId: mlDestinationStub.runPodConsented.id,
      acknowledgeCloudUpload: true,
    });

    expect(selection).toMatchObject({ kind: MlDestinationKind.RunPod, workload: MlWorkload.RestorationCreative });
    expect(selection.endpoint).toEqual(runPodEndpoint);
  });

  it('refuses a worker that reports no qualified model for the mode', async () => {
    const d = deps({ probe: mlProbeStub.healthy });
    const request = {
      mode: RestorationMode.Faithful,
      destinationId: mlDestinationStub.lan.id,
      acknowledgeCloudUpload: false,
    };

    expect(await refusalOf(selectRestorationDestination(d, request))).toBe(MlAdmissionRefusal.WorkloadNotServed);
  });
});

describe('restorationTargetGeometry', () => {
  it.each([
    [1920, 1080, 2, 3840, 2160],
    [1280, 720, 2, 2560, 1440],
    [3000, 2000, 2, 3840, 2560],
    [1080, 1920, 2, 2160, 3840],
    [721, 405, 1, 720, 404],
    [640, 480, 2, 1280, 960],
  ] as const)('%ix%i at %ix is %ix%i', (width, height, scale, targetWidth, targetHeight) => {
    expect(restorationTargetGeometry(width, height, scale)).toEqual({ width: targetWidth, height: targetHeight });
  });
});

const model = (overrides: Partial<RestorationModelCapability> = {}): RestorationModelCapability => ({
  id: 'realbasicvsr-x4',
  family: 'realbasicvsr',
  mode: RestorationMode.Faithful,
  displayName: 'RealBasicVSR x4',
  revision: '0123456789abcdef0123456789abcdef01234567',
  fingerprint: 'a'.repeat(64),
  state: RestorationModelState.Available,
  reasons: [],
  nativeScale: 4,
  maxInputLongEdge: 1280,
  maxFrames: 300,
  dynamicRanges: [RestorationDynamicRange.Sdr],
  measured: [
    { gpu: 'GPU A', inputWidth: 640, inputHeight: 360, frames: 150, framesPerSecond: 5, peakVramBytes: 1 },
    { gpu: 'GPU A', inputWidth: 1280, inputHeight: 720, frames: 150, framesPerSecond: 2, peakVramBytes: 1 },
  ],
  qualificationId: 'realbasicvsr-x4-2026-09',
  ...overrides,
});

describe('chooseRestorationModel', () => {
  it('chooses an available model for the mode', () => {
    expect(chooseRestorationModel([model()], RestorationMode.Faithful)).toEqual({ available: true, model: model() });
  });

  it('explains every reason nothing is available', () => {
    const reasons = ['evidence compare-faces is pending'];
    const unqualified = model({ state: RestorationModelState.Unqualified, reasons });

    expect(chooseRestorationModel([unqualified], RestorationMode.Faithful)).toEqual({
      available: false,
      reasons: ['realbasicvsr-x4: unqualified (evidence compare-faces is pending)'],
    });
    expect(chooseRestorationModel([model()], RestorationMode.Creative)).toEqual({
      available: false,
      reasons: ['no creative model is configured'],
    });
  });

  it('only accepts the exact model a preview was made with', () => {
    expect(chooseRestorationModel([model()], RestorationMode.Faithful, 'b'.repeat(64))).toMatchObject({
      available: false,
    });
    expect(chooseRestorationModel([model()], RestorationMode.Faithful, 'a'.repeat(64))).toMatchObject({
      available: true,
    });
  });
});

describe('estimateRestorationSeconds', () => {
  it('uses the smallest measured input that covers the source', () => {
    expect(estimateRestorationSeconds(model(), { width: 640, height: 360, frames: 150 })).toBe(30);
    expect(estimateRestorationSeconds(model(), { width: 960, height: 540, frames: 150 })).toBe(75);
  });

  it('gives no estimate for a source larger than anything measured or another GPU', () => {
    expect(estimateRestorationSeconds(model(), { width: 1920, height: 1080, frames: 150 })).toBeNull();
    expect(estimateRestorationSeconds(model(), { width: 640, height: 360, frames: 150 }, 'GPU B')).toBeNull();
    expect(estimateRestorationSeconds(model({ measured: [] }), { width: 640, height: 360, frames: 1 })).toBeNull();
  });
});
