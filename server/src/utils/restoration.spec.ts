import { describe, expect, it, vi } from 'vitest';
import type { MachineLearningRepository, MlEndpointProbe } from 'src/repositories/machine-learning.repository.js';
import type { MlDestinationRepository, MlDestinationRow } from 'src/repositories/ml-destination.repository.js';
import {
  AssetRestorationMode,
  AssetRestorationSourceType,
  AssetRestorationStatus,
} from 'src/dtos/asset-restoration.dto.js';
import {
  MediaOperationDestination,
  MediaOperationKind,
  MlAdmissionRefusal,
  MlDestinationKind,
  MlWorkload,
} from 'src/enum.js';
import { MlDestinationRefusedError, selectMlDestination } from 'src/utils/ml-destination.js';
import {
  RESTORATION_PREVIEW_AFTER_DECISION_DAYS,
  RESTORATION_PREVIEW_EDGE,
  RESTORATION_PREVIEW_UNREVIEWED_DAYS,
  RestorationSnapshot,
  canAcceptRestoration,
  canDiscardRestoration,
  canRunStage,
  canSelectRestoration,
  cappedOutputSize,
  estimateSeconds,
  isFullRegion,
  isReviewedModel,
  mediaOperationDestinationOf,
  parseRestorationSnapshot,
  planRestorationChunks,
  previewExpiryAfterDecision,
  previewExpiryAfterReady,
  previewInputBytes,
  previewRegionPixels,
  restorationAdmissionOf,
  restorationChunkIdentity,
  restorationEstimate,
  restorationOutputPaths,
  selectRestorationDestination,
  stageOfKind,
  workloadForMode,
} from 'src/utils/restoration.js';
import { mlDestinationStub, mlProbeStub } from 'test/fixtures/ml-destination.stub.js';

const snapshot = (overrides: Partial<RestorationSnapshot> = {}): RestorationSnapshot => ({
  version: 1,
  stage: 'preview',
  restorationId: '0195e2a0-0000-7000-8000-000000000010',
  assetId: 'asset-1',
  ownerId: 'owner-1',
  sourceType: AssetRestorationSourceType.Image,
  sourceChecksumHex: 'abcd',
  sourceWidth: 6000,
  sourceHeight: 4000,
  sourceDurationSeconds: null,
  mode: AssetRestorationMode.Faithful,
  upscale: 2,
  keepGrain: false,
  workload: MlWorkload.RestorationFaithful,
  destinationId: 'destination-1',
  destinationKind: MlDestinationKind.Local,
  region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
  output: { width: 3240, height: 2160 },
  ...overrides,
});

describe('restoration rules (FL-115)', () => {
  describe('modes and kinds', () => {
    it('maps each mode to its own workload and each job kind to a stage', () => {
      expect(workloadForMode(AssetRestorationMode.Faithful)).toBe(MlWorkload.RestorationFaithful);
      expect(workloadForMode(AssetRestorationMode.Creative)).toBe(MlWorkload.RestorationCreative);
      expect(stageOfKind(MediaOperationKind.RestorationPreview)).toBe('preview');
      expect(stageOfKind(MediaOperationKind.Restoration)).toBe('full');
      expect(stageOfKind(MediaOperationKind.StudioExport)).toBeNull();
    });

    it('maps destination kinds one to one and never invents a cloud destination', () => {
      expect(mediaOperationDestinationOf(MlDestinationKind.Local)).toBe(MediaOperationDestination.Local);
      expect(mediaOperationDestinationOf(MlDestinationKind.Lan)).toBe(MediaOperationDestination.Lan);
      expect(mediaOperationDestinationOf(MlDestinationKind.RunPod)).toBe(MediaOperationDestination.RunPod);
    });
  });

  describe('sizing', () => {
    it('turns a fractional region into a clamped pixel rectangle', () => {
      expect(previewRegionPixels({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 4000, 3000)).toEqual({
        left: 1000,
        top: 750,
        width: 2000,
        height: 1500,
      });
      // A region hanging past the edge is clamped to the frame rather than producing an empty extract.
      expect(previewRegionPixels({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }, 100, 100)).toEqual({
        left: 84,
        top: 84,
        width: 16,
        height: 16,
      });
      expect(isFullRegion({ x: 0, y: 0, w: 1, h: 1 })).toBe(true);
      expect(isFullRegion({ x: 0, y: 0, w: 0.5, h: 1 })).toBe(false);
    });

    it('caps the full output at 4K on both edges and reports when the cap won', () => {
      expect(cappedOutputSize(1920, 1080, 2)).toEqual({ width: 3840, height: 2160, scale: 2, capped: false });
      expect(cappedOutputSize(6000, 4000, 2)).toEqual({ width: 3240, height: 2160, scale: 0.54, capped: true });
      // Portrait: the long edge is the height.
      expect(cappedOutputSize(1080, 1920, 4)).toEqual({ width: 2160, height: 3840, scale: 2, capped: true });
      expect(cappedOutputSize(800, 600, 1)).toEqual({ width: 800, height: 600, scale: 1, capped: false });
    });

    it('derives the preview payload from the region area and the preview edge', () => {
      const full = previewInputBytes(
        4_000_000,
        { x: 0, y: 0, w: 1, h: 1 },
        1024,
        768,
        AssetRestorationSourceType.Image,
        null,
      );
      expect(full).toBe(4_000_000);
      const quarter = previewInputBytes(
        4_000_000,
        { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
        1024,
        768,
        AssetRestorationSourceType.Image,
        null,
      );
      expect(quarter).toBe(1_000_000);
      // A large frame is downscaled to the preview edge, shrinking the upload further.
      const large = previewInputBytes(
        40_000_000,
        { x: 0, y: 0, w: 1, h: 1 },
        8192,
        6144,
        AssetRestorationSourceType.Image,
        null,
      );
      expect(large).toBe(Math.round(40_000_000 * (RESTORATION_PREVIEW_EDGE / 8192) ** 2));
      // Video previews scale by clip length.
      expect(
        previewInputBytes(100_000_000, { x: 0, y: 0, w: 1, h: 1 }, 1920, 1080, AssetRestorationSourceType.Video, 50),
      ).toBe(10_000_000);
    });
  });

  describe('estimates', () => {
    it('never invents a figure: no samples means null seconds', () => {
      const none = { sampleCount: 0, bytesSent: 0, durationMs: 0, spentUsd: 0 };
      expect(estimateSeconds(1_000_000, none)).toBeNull();
      const estimate = restorationEstimate(none, { preview: 1000, full: 5000 }, 30);
      expect(estimate).toEqual({
        sampleCount: 0,
        bytesPerSecond: null,
        windowDays: 30,
        previewBytes: 1000,
        fullBytes: 5000,
        previewSeconds: null,
        fullSeconds: null,
      });
    });

    it('derives seconds from measured throughput', () => {
      const sample = { sampleCount: 4, bytesSent: 8_000_000, durationMs: 4000, spentUsd: 0 };
      expect(estimateSeconds(4_000_000, sample)).toBe(2);
      expect(restorationEstimate(sample, { preview: 1_000_000, full: 20_000_000 }, 30)).toMatchObject({
        bytesPerSecond: 2_000_000,
        previewSeconds: 0.5,
        fullSeconds: 10,
      });
    });
  });

  describe('state machine', () => {
    it('allows accept and reject only on a ready preview and selection only on a finished result', () => {
      expect(canAcceptRestoration(AssetRestorationStatus.PreviewReady)).toBe(true);
      expect(canAcceptRestoration(AssetRestorationStatus.PreviewRendering)).toBe(false);
      expect(canAcceptRestoration(AssetRestorationStatus.Restored)).toBe(false);
      expect(canSelectRestoration(AssetRestorationStatus.Restored)).toBe(true);
      expect(canSelectRestoration(AssetRestorationStatus.PreviewReady)).toBe(false);
      expect(canDiscardRestoration(AssetRestorationStatus.Discarded)).toBe(false);
      expect(canDiscardRestoration(AssetRestorationStatus.Restored)).toBe(true);
    });

    it('lets a stage resume only from its own states, so a retry can never cross a decision', () => {
      for (const status of [
        AssetRestorationStatus.PreviewQueued,
        AssetRestorationStatus.PreviewRendering,
        AssetRestorationStatus.PreviewFailed,
        AssetRestorationStatus.PreviewCancelled,
      ]) {
        expect(canRunStage('preview', status)).toBe(true);
        expect(canRunStage('full', status)).toBe(false);
      }
      for (const status of [
        AssetRestorationStatus.Accepted,
        AssetRestorationStatus.Restoring,
        AssetRestorationStatus.RestoreFailed,
        AssetRestorationStatus.RestoreCancelled,
      ]) {
        expect(canRunStage('full', status)).toBe(true);
        expect(canRunStage('preview', status)).toBe(false);
      }
      for (const status of [
        AssetRestorationStatus.PreviewReady,
        AssetRestorationStatus.Rejected,
        AssetRestorationStatus.Restored,
        AssetRestorationStatus.Discarded,
      ]) {
        expect(canRunStage('preview', status)).toBe(false);
        expect(canRunStage('full', status)).toBe(false);
      }
    });

    it('sets retention dates from the moment of readiness and of decision', () => {
      const now = new Date('2026-09-22T12:00:00.000Z');
      expect(previewExpiryAfterReady(now).getTime() - now.getTime()).toBe(
        RESTORATION_PREVIEW_UNREVIEWED_DAYS * 86_400_000,
      );
      expect(previewExpiryAfterDecision(now).getTime() - now.getTime()).toBe(
        RESTORATION_PREVIEW_AFTER_DECISION_DAYS * 86_400_000,
      );
    });
  });

  describe('snapshot', () => {
    it('round-trips a valid snapshot and rejects one it cannot read back exactly', () => {
      const valid = snapshot();
      expect(parseRestorationSnapshot(valid)).toEqual(valid);
      expect(parseRestorationSnapshot({ ...valid, version: 2 })).toBeNull();
      expect(parseRestorationSnapshot({ ...valid, destinationId: '' })).toBeNull();
      expect(parseRestorationSnapshot({ ...valid, upscale: 3 })).toBeNull();
      expect(parseRestorationSnapshot(null)).toBeNull();
    });
  });

  describe('video chunks', () => {
    it('cuts a video into fixed chunks with the remainder in the last one', () => {
      expect(planRestorationChunks(45, 20)).toEqual([
        { sequence: 0, startSeconds: 0, endSeconds: 20 },
        { sequence: 1, startSeconds: 20, endSeconds: 40 },
        { sequence: 2, startSeconds: 40, endSeconds: 45 },
      ]);
      expect(planRestorationChunks(5, 20)).toEqual([{ sequence: 0, startSeconds: 0, endSeconds: 5 }]);
      expect(planRestorationChunks(0)).toEqual([]);
    });

    it('keys a chunk by every input that changes its output, never by its number alone', () => {
      const base = snapshot({ stage: 'full', sourceType: AssetRestorationSourceType.Video, sourceDurationSeconds: 45 });
      const chunk = { sequence: 1, startSeconds: 20, endSeconds: 40 };
      const identity = restorationChunkIdentity(base, chunk);
      expect(identity.sequence).toBe(1);
      expect(identity.timebase).toBe('1/1000');
      expect(identity.startTicks).toBe(20_000n);
      expect(identity.endTicks).toBe(40_000n);
      expect(restorationChunkIdentity(base, chunk).chunkKey).toBe(identity.chunkKey);
      expect(restorationChunkIdentity(base, { ...chunk, endSeconds: 41 }).chunkKey).not.toBe(identity.chunkKey);
      expect(restorationChunkIdentity({ ...base, sourceChecksumHex: 'ffff' }, chunk).chunkKey).not.toBe(
        identity.chunkKey,
      );
      expect(restorationChunkIdentity({ ...base, mode: AssetRestorationMode.Creative }, chunk).chunkKey).not.toBe(
        identity.chunkKey,
      );
      expect(restorationChunkIdentity({ ...base, destinationId: 'elsewhere' }, chunk).chunkKey).not.toBe(
        identity.chunkKey,
      );
      expect(
        restorationChunkIdentity({ ...base, model: { name: 'faithful-v1', version: 'r2' } }, chunk).chunkKey,
      ).not.toBe(identity.chunkKey);
    });
  });

  describe('reviewed model binding', () => {
    it('accepts only the model and revision the preview ran, once a snapshot binds one', () => {
      const bound = { model: { name: 'faithful-v1', version: 'r1' } };
      expect(isReviewedModel(bound, { modelName: 'faithful-v1', modelVersion: 'r1' })).toBe(true);
      expect(isReviewedModel(bound, { modelName: 'faithful-v1', modelVersion: 'r2' })).toBe(false);
      expect(isReviewedModel(bound, { modelName: 'creative-v1', modelVersion: 'r1' })).toBe(false);
      expect(isReviewedModel({ model: { name: 'm', version: null } }, { modelName: 'm', modelVersion: null })).toBe(
        true,
      );
      expect(isReviewedModel({}, { modelName: 'anything', modelVersion: null })).toBe(true);
    });

    it('round-trips a snapshot that binds a model', () => {
      const valid = snapshot({ stage: 'full', model: { name: 'faithful-v1', version: null } });
      expect(parseRestorationSnapshot(valid)).toEqual(valid);
      expect(parseRestorationSnapshot({ ...valid, model: { name: '', version: null } })).toBeNull();
    });
  });

  describe('paths', () => {
    it('names outputs by restoration id so a re-run lands on the same paths', () => {
      const paths = restorationOutputPaths('/data/thumbs/o/as/se', 'asset-1', 'rest-1');
      expect(paths.before).toBe('/data/thumbs/o/as/se/asset-1_restore_rest-1_before');
      expect(paths.result).toBe('/data/thumbs/o/as/se/asset-1_restore_rest-1_result');
      expect(paths.resultPreview).toBe('/data/thumbs/o/as/se/asset-1_restore_rest-1_result_preview.jpg');
    });
  });
});

const runPodEndpoint = { url: 'https://pod.proxy.runpod.net/', authToken: 'rpa_test_key' };

const deps = (overrides: {
  destination?: MlDestinationRow;
  probe?: MlEndpointProbe;
  route?: { workload: MlWorkload; destinationId: string };
  /** Every route, for the FL-72 check that restoration never lands on a library endpoint. */
  routes?: Array<{ workload: MlWorkload; destinationId: string }>;
  others?: MlDestinationRow[];
  runPod?: { url: string; authToken?: string } | null;
}) => {
  const destination = overrides.destination ?? mlDestinationStub.lan;
  const rows = [destination, ...(overrides.others ?? [])];
  const find = (id: string) => Promise.resolve(rows.find((row) => row.id === id));
  const mlDestinationRepository = {
    getById: vi.fn().mockImplementation(find),
    getSpend: vi.fn().mockResolvedValue(0),
    recordProbe: vi.fn().mockResolvedValue(undefined),
    recordAccounting: vi.fn().mockResolvedValue(undefined),
    getRoute: vi.fn().mockResolvedValue(overrides.route),
    getRoutes: vi.fn().mockResolvedValue(overrides.routes ?? []),
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

describe('selectRestorationDestination (FL-114)', () => {
  it('admits the LAN worker the person chose and records the admission', async () => {
    const d = deps({});

    const selection = await selectRestorationDestination(d, {
      mode: AssetRestorationMode.Faithful,
      destinationId: mlDestinationStub.lan.id,
      acknowledgeCloudUpload: false,
      jobId: 'operation-1',
    });

    expect(selection).toMatchObject({
      destinationId: mlDestinationStub.lan.id,
      kind: MlDestinationKind.Lan,
      workload: MlWorkload.RestorationFaithful,
    });
    expect(restorationAdmissionOf(selection)).toEqual({ cloudUploadConfirmed: false });
    expect(d.machineLearningRepository.probe).toHaveBeenCalledTimes(1);
  });

  it('never marks a plain selection or a copy of an admitted one as admitted', async () => {
    const d = deps({});
    const plain = await selectMlDestination(d, {
      workload: MlWorkload.RestorationFaithful,
      destinationId: mlDestinationStub.lan.id,
    });
    const admitted = await selectRestorationDestination(d, {
      mode: AssetRestorationMode.Faithful,
      destinationId: mlDestinationStub.lan.id,
      acknowledgeCloudUpload: false,
    });

    expect(restorationAdmissionOf(plain)).toBeNull();
    expect(restorationAdmissionOf({ ...admitted })).toBeNull();
  });

  it('uses the administrator route when the person made no choice', async () => {
    const d = deps({ route: { workload: MlWorkload.RestorationFaithful, destinationId: mlDestinationStub.lan.id } });

    const selection = await selectRestorationDestination(d, {
      mode: AssetRestorationMode.Faithful,
      destinationId: null,
      acknowledgeCloudUpload: false,
    });

    expect(selection.destinationId).toBe(mlDestinationStub.lan.id);
    expect(d.mlDestinationRepository.getRoute).toHaveBeenCalledWith(MlWorkload.RestorationFaithful);
  });

  it('refuses when there is neither a choice nor a route', async () => {
    const d = deps({});
    const request = { mode: AssetRestorationMode.Creative, destinationId: null, acknowledgeCloudUpload: false };

    expect(await refusalOf(selectRestorationDestination(d, request))).toBe(MlAdmissionRefusal.WorkloadNotRouted);
    expect(d.machineLearningRepository.probe).not.toHaveBeenCalled();
  });

  it('never contacts a cloud destination until the person confirms the upload', async () => {
    const d = deps({ destination: mlDestinationStub.runPodVideoConsented, runPod: runPodEndpoint });
    const request = {
      mode: AssetRestorationMode.Creative,
      destinationId: mlDestinationStub.runPodVideoConsented.id,
      acknowledgeCloudUpload: false,
    };

    expect(await refusalOf(selectRestorationDestination(d, request))).toBe(MlAdmissionRefusal.ConsentMissing);
    expect(d.machineLearningRepository.probe).not.toHaveBeenCalled();
  });

  it('also refuses a routed cloud destination nobody confirmed', async () => {
    const d = deps({
      destination: mlDestinationStub.runPodVideoConsented,
      runPod: runPodEndpoint,
      route: { workload: MlWorkload.RestorationCreative, destinationId: mlDestinationStub.runPodVideoConsented.id },
    });
    const request = { mode: AssetRestorationMode.Creative, destinationId: null, acknowledgeCloudUpload: false };

    expect(await refusalOf(selectRestorationDestination(d, request))).toBe(MlAdmissionRefusal.ConsentMissing);
    expect(d.machineLearningRepository.probe).not.toHaveBeenCalled();
  });

  it('still needs the administrator consent when the person confirms the upload', async () => {
    const d = deps({ destination: mlDestinationStub.runPodVideo, runPod: runPodEndpoint });
    const request = {
      mode: AssetRestorationMode.Creative,
      destinationId: mlDestinationStub.runPodVideo.id,
      acknowledgeCloudUpload: true,
    };

    expect(await refusalOf(selectRestorationDestination(d, request))).toBe(MlAdmissionRefusal.ConsentMissing);
    expect(d.machineLearningRepository.probe).not.toHaveBeenCalled();
  });

  it('admits a consented cloud destination once the person confirms the upload', async () => {
    const d = deps({ destination: mlDestinationStub.runPodVideoConsented, runPod: runPodEndpoint });

    const selection = await selectRestorationDestination(d, {
      mode: AssetRestorationMode.Creative,
      destinationId: mlDestinationStub.runPodVideoConsented.id,
      acknowledgeCloudUpload: true,
    });

    expect(selection).toMatchObject({ kind: MlDestinationKind.RunPodVideo, workload: MlWorkload.RestorationCreative });
    // The video worker's own address, never the library-analysis pod the RunPod service published (FL-72).
    expect(selection.endpoint).toEqual({ url: mlDestinationStub.runPodVideoConsented.url, authToken: 'video-token' });
    expect(restorationAdmissionOf(selection)).toEqual({ cloudUploadConfirmed: true });
  });

  it('refuses a worker that reports no qualified model for the mode', async () => {
    const d = deps({ probe: mlProbeStub.healthy });
    const request = {
      mode: AssetRestorationMode.Faithful,
      destinationId: mlDestinationStub.lan.id,
      acknowledgeCloudUpload: false,
    };

    expect(await refusalOf(selectRestorationDestination(d, request))).toBe(MlAdmissionRefusal.WorkloadNotServed);
  });

  it('refuses restoration on the managed RunPod pod, which is a library-analysis worker (FL-72)', async () => {
    const legacy = { ...mlDestinationStub.runPodConsented, workloads: [MlWorkload.RestorationCreative] };
    const d = deps({ destination: legacy, runPod: runPodEndpoint });
    const request = { mode: AssetRestorationMode.Creative, destinationId: legacy.id, acknowledgeCloudUpload: true };

    expect(await refusalOf(selectRestorationDestination(d, request))).toBe(MlAdmissionRefusal.RoleConflict);
    expect(d.machineLearningRepository.probe).not.toHaveBeenCalled();
  });

  it('refuses restoration on an endpoint library analysis is routed to, without moving it (FL-72)', async () => {
    const sharedUrl = { ...mlDestinationStub.lan, url: mlDestinationStub.local.url };
    const d = deps({
      destination: sharedUrl,
      others: [mlDestinationStub.local],
      routes: [{ workload: MlWorkload.Face, destinationId: mlDestinationStub.local.id }],
    });
    const request = { mode: AssetRestorationMode.Faithful, destinationId: sharedUrl.id, acknowledgeCloudUpload: false };

    expect(await refusalOf(selectRestorationDestination(d, request))).toBe(MlAdmissionRefusal.RoleConflict);
    expect(d.machineLearningRepository.probe).not.toHaveBeenCalled();
  });
});
