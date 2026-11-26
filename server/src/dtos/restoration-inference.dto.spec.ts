import { describe, expect, it } from 'vitest';
import { AssetRestorationMode } from 'src/dtos/asset-restoration.dto.js';
import {
  RESTORATION_PROTOCOL,
  RestorationModelState,
  RestorationWorkerRequestSchema,
  verifiedPhotoOperations,
} from 'src/dtos/restoration-inference.dto.js';
import { MlAdmissionRefusal, MlDestinationKind, MlWorkload } from 'src/enum.js';
import { evaluateAdmission, resolveEndpoint } from 'src/utils/ml-destination.js';
import { mlDestinationStub, mlProbeStub } from 'test/fixtures/ml-destination.stub.js';

const model = (operation: 'repair' | 'colourise', overrides = {}) => ({
  id: `${operation}-model`,
  operation,
  fingerprint: 'a'.repeat(64),
  state: RestorationModelState.Available,
  qualificationId: 'qualification-1',
  ...overrides,
});

describe('photo operations from a worker report (FL-955)', () => {
  it('accepts both names when a qualified model backs each', () => {
    expect(
      verifiedPhotoOperations({
        workloads: ['photo-repair', 'colourise'],
        photoModels: [model('repair'), model('colourise')],
      }),
    ).toEqual(['repair', 'colourise']);
  });

  it('drops a listed name without a qualified, verified model', () => {
    expect(
      verifiedPhotoOperations({
        workloads: ['photo-repair', 'colourise'],
        photoModels: [model('repair', { qualificationId: null }), model('colourise', { fingerprint: null })],
      }),
    ).toEqual([]);
    expect(
      verifiedPhotoOperations({
        workloads: ['photo-repair'],
        photoModels: [model('repair', { state: RestorationModelState.Unqualified })],
      }),
    ).toEqual([]);
  });

  it('drops a model the worker does not list', () => {
    expect(verifiedPhotoOperations({ workloads: [], photoModels: [model('repair')] })).toEqual([]);
  });

  const admit = (destination: typeof mlDestinationStub.lan, photoOperations?: ('repair' | 'colourise')[]) =>
    evaluateAdmission({
      destination,
      workload: MlWorkload.RestorationFaithful,
      endpoint: resolveEndpoint(destination),
      probe: { ...mlProbeStub.healthy, workloads: [], ...(photoOperations && { photoOperations }) },
      spentUsd: 0,
      photoOperation: 'repair',
    });

  it('admits a home worker that proved the operation, even with no faithful model', () => {
    expect(admit(mlDestinationStub.lan, ['repair'])).toEqual({ admitted: true });
  });

  it('refuses a worker that has not, which is every worker today', () => {
    expect(admit(mlDestinationStub.lan)).toMatchObject({
      admitted: false,
      refusal: MlAdmissionRefusal.WorkloadNotServed,
    });
  });

  it('refuses Frameleaf Cloud until it offers the operation', () => {
    expect(mlDestinationStub.frameleafCloud.kind).toBe(MlDestinationKind.FrameleafCloud);
    expect(admit(mlDestinationStub.frameleafCloud, ['repair'])).toMatchObject({
      admitted: false,
      refusal: MlAdmissionRefusal.WorkloadNotServed,
    });
  });
});

describe('the worker request (FL-933 contract)', () => {
  const base = {
    protocol: RESTORATION_PROTOCOL,
    requestId: 'job:result.png',
    kind: 'image',
    scale: 1,
    maxWidth: 3840,
    maxHeight: 3840,
    keepGrain: false,
    seed: 0,
    source: { width: 800, height: 600 },
  };

  it('names an operation instead of a mode', () => {
    expect(RestorationWorkerRequestSchema.safeParse({ ...base, operation: 'repair' }).success).toBe(true);
    expect(RestorationWorkerRequestSchema.safeParse({ ...base, mode: AssetRestorationMode.Faithful }).success).toBe(
      true,
    );
  });

  it('refuses both, neither, or a photo operation that resizes', () => {
    const both = { ...base, operation: 'repair', mode: AssetRestorationMode.Faithful };
    expect(RestorationWorkerRequestSchema.safeParse(both).success).toBe(false);
    expect(RestorationWorkerRequestSchema.safeParse(base).success).toBe(false);
    expect(RestorationWorkerRequestSchema.safeParse({ ...base, operation: 'repair', scale: 2 }).success).toBe(false);
  });
});
