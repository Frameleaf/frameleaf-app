import { ConflictException } from '@nestjs/common';
import type { Mock } from 'vitest';
import { defaults } from 'src/dtos/config.dto.js';
import {
  AssetVisibility,
  JobName,
  JobStatus,
  MlAdmissionRefusal,
  MlDestinationHealth,
  MlDestinationKind,
  MlWorkload,
  PetRecognitionRunStatus,
  PetRecognitionUnavailableReason,
  PetSpecies,
} from 'src/enum.js';
import { PetRepository } from 'src/repositories/pet.repository.js';
import {
  PetRecognitionService,
  asUnavailableReason,
  clearPetPromptCache,
} from 'src/services/pet-recognition.service.js';
import { clearConfigCache } from 'src/utils/config.js';
import { PET_NEGATIVE_PROMPTS, PET_SPECIES_PROMPTS, petRecognitionRun } from 'src/utils/pets.js';
import { mlDestinationStub } from 'test/fixtures/ml-destination.stub.js';
import { ServiceMocks, getMocks } from 'test/utils.js';

type AnyMock = Mock<(...args: any[]) => any>;

const ownerId = 'owner-1';
const assetId = 'asset-1';
const catId = 'pet-cat';
const dogId = 'pet-dog';
const runId = 'run-1';
const DIMENSIONS = 16;
const clipModel = defaults.machineLearning.clip.modelName;

/** A fake CLIP space: each prompt owns one axis, and axis 15 is what photos of the same animal share. */
const axis = (index: number) => Array.from({ length: DIMENSIONS }, (_, i) => (i === index ? 1 : 0));
const mix = (...vectors: number[][]) => {
  const sum = Array.from({ length: DIMENSIONS }, () => 0);
  for (const vector of vectors) {
    for (const [i, value] of vector.entries()) {
      sum[i] += value;
    }
  }
  const norm = Math.hypot(...sum);
  return sum.map((value) => value / norm);
};
const asText = (vector: number[]) => `[${vector.join(',')}]`;
const prompts = [...PET_SPECIES_PROMPTS.map(({ prompt }) => prompt), ...PET_NEGATIVE_PROMPTS];
const promptAxis = (text: string) => prompts.indexOf(text);

const catPhoto = asText(mix(axis(0), axis(15)));
const landscapePhoto = asText(mix(axis(PET_SPECIES_PROMPTS.length + 2), axis(15)));

const localWithPets = {
  ...mlDestinationStub.local,
  workloads: [...mlDestinationStub.local.workloads, MlWorkload.PetRecognition],
  lastProbeWorkloads: [...(mlDestinationStub.local.lastProbeWorkloads ?? []), MlWorkload.PetRecognition],
};

const recognitionAsset = (overrides: Record<string, unknown> = {}) => ({
  id: assetId,
  ownerId,
  visibility: AssetVisibility.Timeline,
  deletedAt: null,
  width: 4000,
  height: 3000,
  exifImageWidth: null,
  exifImageHeight: null,
  embedding: catPhoto,
  ...overrides,
});

describe(PetRecognitionService.name, () => {
  let sut: PetRecognitionService;
  let mocks: ServiceMocks;
  let pets: Record<string, AnyMock>;

  beforeEach(() => {
    clearConfigCache();
    clearPetPromptCache();
    mocks = getMocks();
    mocks.mlDestination.getById.mockResolvedValue(localWithPets);
    mocks.machineLearning.probe.mockResolvedValue({
      reachable: true,
      workloads: localWithPets.lastProbeWorkloads,
      hardware: null,
      latencyMs: 5,
      probedAt: new Date(),
      error: null,
    });
    mocks.machineLearning.encodeText.mockImplementation((_selection, text: string) =>
      Promise.resolve(asText(axis(promptAxis(text)))),
    );
    pets = {
      getRun: vi.fn().mockResolvedValue(undefined),
      hasConfirmedObservations: vi.fn().mockResolvedValue(true),
      getRecognitionAsset: vi.fn().mockResolvedValue(recognitionAsset()),
      getRecognitionReferences: vi.fn().mockResolvedValue([
        { petId: catId, species: PetSpecies.Cat, embedding: catPhoto },
        { petId: dogId, species: PetSpecies.Dog, embedding: catPhoto },
      ]),
      getDetectionsForAsset: vi.fn().mockResolvedValue([]),
      replaceDetections: vi
        .fn()
        .mockImplementation((_asset, _ids, rows: unknown[]) =>
          Promise.resolve(rows.map((row, index) => ({ ...(row as object), id: `detection-${index}` }))),
        ),
      upsertCandidates: vi.fn(),
      getDecisionsForAsset: vi.fn().mockResolvedValue([]),
      upsertObservation: vi.fn(),
      deleteObservation: vi.fn(),
      isRunActive: vi.fn().mockResolvedValue(true),
      recordRunProgress: vi.fn(),
      failRun: vi.fn(),
      startRun: vi.fn().mockResolvedValue({ id: runId, ownerId, status: PetRecognitionRunStatus.Queued }),
      setRunAssets: vi.fn(),
      cancelRun: vi.fn(),
      getRecognizableAssetIds: vi.fn().mockResolvedValue(['a', 'b']),
      getOwnersWithConfirmedPets: vi.fn().mockResolvedValue([ownerId]),
      getNearestAssetIds: vi.fn().mockResolvedValue(['near-1', 'near-2']),
      getByIds: vi.fn().mockResolvedValue([{ id: catId }]),
      flagStaleRegions: vi.fn().mockResolvedValue(1),
    };

    sut = new PetRecognitionService(
      mocks.logger as never,
      pets as unknown as PetRepository,
      mocks.mlDestination as never,
      mocks.machineLearning as never,
      mocks.job as never,
      mocks.config as never,
      mocks.systemMetadata as never,
    );
  });

  it('has a Pets page reason for every destination refusal', () => {
    for (const refusal of Object.values(MlAdmissionRefusal)) {
      expect(Object.values(PetRecognitionUnavailableReason)).toContain(asUnavailableReason(refusal));
    }
  });

  describe('getStatus', () => {
    it('names the routed local destination when it serves pet recognition', async () => {
      await expect(sut.getStatus(ownerId)).resolves.toMatchObject({
        available: true,
        reason: null,
        destination: { kind: MlDestinationKind.Local, name: 'This server' },
      });
      // the status never contacts a worker
      expect(mocks.machineLearning.probe).not.toHaveBeenCalled();
    });

    it('says no destination is routed instead of falling back to another one', async () => {
      mocks.mlDestination.getRoute.mockResolvedValue(undefined);

      await expect(sut.getStatus(ownerId)).resolves.toMatchObject({
        available: false,
        reason: PetRecognitionUnavailableReason.WorkloadNotRouted,
        destination: null,
      });
    });

    it('refuses a cloud destination without recorded consent', async () => {
      mocks.mlDestination.getById.mockResolvedValue({
        ...mlDestinationStub.runPod,
        workloads: [MlWorkload.PetRecognition],
      });

      await expect(sut.getStatus(ownerId)).resolves.toMatchObject({
        available: false,
        reason: PetRecognitionUnavailableReason.ConsentMissing,
        destination: { kind: MlDestinationKind.RunPod },
      });
    });

    it('reports an unavailable worker with its reason', async () => {
      mocks.mlDestination.getById.mockResolvedValue({
        ...localWithPets,
        lastProbeHealth: MlDestinationHealth.Unhealthy,
        lastProbeSummary: 'Unreachable: fetch failed',
      });

      await expect(sut.getStatus(ownerId)).resolves.toMatchObject({
        available: false,
        reason: PetRecognitionUnavailableReason.DestinationUnhealthy,
      });
    });

    it('reports a worker whose GPU memory is too small', async () => {
      mocks.mlDestination.getById.mockResolvedValue({
        ...localWithPets,
        lastProbeHardware: {
          preferredAcceleration: null,
          providers: [],
          cudaDeviceCount: 1,
          gpus: [{ name: 'Tiny', memoryTotalBytes: 256 * 1024 ** 2 }],
        },
      });

      await expect(sut.getStatus(ownerId)).resolves.toMatchObject({
        available: false,
        reason: PetRecognitionUnavailableReason.InsufficientMemory,
      });
    });

    it('says smart search is off before looking at destinations', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { clip: { enabled: false } } });

      await expect(sut.getStatus(ownerId)).resolves.toMatchObject({
        reason: PetRecognitionUnavailableReason.SmartSearchDisabled,
      });
      expect(mocks.mlDestination.getRoute).not.toHaveBeenCalled();
    });
  });

  describe('handleRecognize', () => {
    it('proposes a compatible pet for review and never confirms it, however confident', async () => {
      await expect(sut.handleRecognize({ id: assetId })).resolves.toBe(JobStatus.Success);

      expect(pets.replaceDetections).toHaveBeenCalledWith(
        assetId,
        [],
        [
          expect.objectContaining({
            boundingBoxX1: 0,
            boundingBoxY1: 0,
            boundingBoxX2: 4000,
            boundingBoxY2: 3000,
            species: PetSpecies.Cat,
            ...petRecognitionRun(clipModel),
          }),
        ],
      );
      // the dog looks the same in this fake space but is the wrong species
      expect(pets.upsertCandidates).toHaveBeenCalledWith([
        { detectionId: 'detection-0', petId: catId, score: expect.closeTo(1, 5) },
      ]);
      expect(pets.upsertObservation).not.toHaveBeenCalled();
    });

    it('routes the prompts through the admitted destination only', async () => {
      await sut.handleRecognize({ id: assetId });

      expect(mocks.machineLearning.encodeText).toHaveBeenCalledWith(
        expect.objectContaining({ destinationId: localWithPets.id, workload: MlWorkload.PetRecognition }),
        expect.any(String),
        { modelName: clipModel },
      );
    });

    it('keeps an ignored pairing out after a rerun', async () => {
      pets.getDecisionsForAsset.mockResolvedValue([{ petId: catId, state: 'rejected' }]);

      await sut.handleRecognize({ id: assetId });

      expect(pets.upsertCandidates).not.toHaveBeenCalled();
    });

    it('replaces the detections of an older model revision and nothing durable', async () => {
      pets.getDetectionsForAsset.mockResolvedValue([
        { id: 'old-detection', modelName: clipModel, modelRevision: `clip-knn-0:${clipModel}` },
      ]);

      await sut.handleRecognize({ id: assetId });

      expect(pets.replaceDetections).toHaveBeenCalledWith(assetId, ['old-detection'], expect.any(Array));
      expect(pets.upsertObservation).not.toHaveBeenCalled();
      expect(pets.deleteObservation).not.toHaveBeenCalled();
    });

    it('records no detection for a photo that does not read as an animal', async () => {
      pets.getRecognitionAsset.mockResolvedValue(recognitionAsset({ embedding: landscapePhoto }));

      await sut.handleRecognize({ id: assetId });

      expect(pets.replaceDetections).toHaveBeenCalledWith(assetId, [], []);
      expect(pets.upsertCandidates).not.toHaveBeenCalled();
    });

    it('sends nothing anywhere while no pet is confirmed in any photo', async () => {
      pets.getRecognitionReferences.mockResolvedValue([]);

      await expect(sut.handleRecognize({ id: assetId })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.machineLearning.encodeText).not.toHaveBeenCalled();
      expect(mocks.machineLearning.probe).not.toHaveBeenCalled();
    });

    it('fails the run with the refusal when the cloud destination has no consent, sending nothing', async () => {
      mocks.mlDestination.getById.mockResolvedValue({
        ...mlDestinationStub.runPod,
        workloads: [MlWorkload.PetRecognition],
      });

      await expect(sut.handleRecognize({ id: assetId, runId })).resolves.toBe(JobStatus.Failed);
      expect(pets.failRun).toHaveBeenCalledWith(runId, expect.stringContaining('consent-missing'));
      expect(mocks.machineLearning.encodeText).not.toHaveBeenCalled();
      expect(pets.recordRunProgress).not.toHaveBeenCalled();
    });

    it('stops a job whose run the owner cancelled', async () => {
      pets.isRunActive.mockResolvedValue(false);

      await expect(sut.handleRecognize({ id: assetId, runId })).resolves.toBe(JobStatus.Skipped);
      expect(pets.getRecognitionAsset).not.toHaveBeenCalled();
    });

    it('counts the run’s progress and proposals', async () => {
      await sut.handleRecognize({ id: assetId, runId });

      expect(pets.recordRunProgress).toHaveBeenCalledWith(runId, 1);
    });

    it('leaves hidden live-photo parts and trashed photos alone', async () => {
      pets.getRecognitionAsset.mockResolvedValue(recognitionAsset({ visibility: AssetVisibility.Hidden }));
      await expect(sut.handleRecognize({ id: assetId })).resolves.toBe(JobStatus.Skipped);

      pets.getRecognitionAsset.mockResolvedValue(recognitionAsset({ deletedAt: new Date() }));
      await expect(sut.handleRecognize({ id: assetId })).resolves.toBe(JobStatus.Skipped);
      expect(pets.replaceDetections).not.toHaveBeenCalled();
    });
  });

  describe('runs', () => {
    it('queues the owner’s photos with the run id', async () => {
      pets.getRun.mockResolvedValue({ id: runId, ownerId, status: PetRecognitionRunStatus.Queued });

      await sut.handleQueueAll({ userId: ownerId });

      expect(pets.setRunAssets).toHaveBeenCalledWith(runId, 2);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.PetRecognition, data: { id: 'a', runId } },
        { name: JobName.PetRecognition, data: { id: 'b', runId } },
      ]);
    });

    it('queues nothing for a run cancelled before it started', async () => {
      pets.getRun.mockResolvedValue({ id: runId, ownerId, status: PetRecognitionRunStatus.Cancelled });
      pets.isRunActive.mockResolvedValue(false);

      await sut.handleQueueAll({ userId: ownerId });

      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    // L2: pet_recognition_run is fork-owned; during a database handoff its writes are refused
    it('leaves the run alone during a database handoff instead of failing the job', async () => {
      const handoff = new ConflictException('Pet recognition runs are unavailable during database handoff');
      pets.getRun.mockResolvedValue({ id: runId, ownerId, status: PetRecognitionRunStatus.Queued });
      pets.setRunAssets.mockRejectedValue(handoff);

      await expect(sut.handleQueueAll({ userId: ownerId })).resolves.toBe(JobStatus.Success);
      expect(mocks.job.queueAll).not.toHaveBeenCalled();

      pets.recordRunProgress.mockRejectedValue(handoff);
      await expect(sut.handleRecognize({ id: assetId, runId })).resolves.not.toBe(JobStatus.Failed);
    });

    it('lets any other run write error through', async () => {
      pets.getRun.mockResolvedValue({ id: runId, ownerId, status: PetRecognitionRunStatus.Queued });
      pets.setRunAssets.mockRejectedValue(new Error('connection lost'));
      await expect(sut.handleQueueAll({ userId: ownerId })).rejects.toThrow('connection lost');
    });

    it('starts a run for every owner with a confirmed pet from the Job manager', async () => {
      await sut.handleQueueAll({});

      expect(pets.startRun).toHaveBeenCalledWith(ownerId, null);
      expect(mocks.job.queueAll).toHaveBeenCalled();
    });

    it('looks again at the owner’s most similar photos after a confirmation', async () => {
      pets.getRecognitionAsset.mockResolvedValue(recognitionAsset());

      await sut.handleNearest({ petId: catId, assetId });

      expect(pets.getNearestAssetIds).toHaveBeenCalledWith(ownerId, assetId, 200);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.PetRecognition, data: { id: 'near-1' } },
        { name: JobName.PetRecognition, data: { id: 'near-2' } },
      ]);
    });
  });

  describe('source replacement', () => {
    it('flags drawn regions on a replaced original for review', async () => {
      await sut.onAssetMetadataExtracted({ assetId, userId: ownerId });

      expect(pets.flagStaleRegions).toHaveBeenCalledWith(assetId);
    });
  });
});
