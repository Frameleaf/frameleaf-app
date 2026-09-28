import { ConflictException, Injectable } from '@nestjs/common';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { JobOf } from 'src/types.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import {
  AssetVisibility,
  ImmichWorker,
  JobName,
  JobStatus,
  MlAdmissionRefusal,
  MlDestinationKind,
  MlWorkload,
  PetRecognitionUnavailableReason,
  QueueName,
} from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository, MlSelection } from 'src/repositories/machine-learning.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { PetRecognitionRun, PetRepository } from 'src/repositories/pet.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { getConfig } from 'src/utils/config.js';
import { l2Normalize, parseEmbedding } from 'src/utils/embedding.js';
import { isMachineLearningEnabled, isSmartSearchEnabled } from 'src/utils/misc.js';
import {
  ML_BUDGET_WINDOW_DAYS,
  MlDestinationNotFoundError,
  MlDestinationRefusedError,
  evaluateAdmission,
  resolveEndpoint,
  routedMlDestinationId,
  selectMlDestination,
  storedProbe,
} from 'src/utils/ml-destination.js';
import {
  PET_NEGATIVE_PROMPTS,
  PET_RECOGNITION_THRESHOLDS,
  PET_SPECIES_PROMPTS,
  PetReference,
  detectionsToReplace,
  matchPets,
  petRecognitionRun,
  readSpecies,
} from 'src/utils/pets.js';

/** How many of an owner's most similar photos a newly confirmed pet photo sends through recognition. */
export const PET_NEAREST_ASSET_LIMIT = 200;

const QUEUE_BATCH = 1000;

type PromptEmbeddings = {
  species: Array<{ species: (typeof PET_SPECIES_PROMPTS)[number]['species']; embedding: Float32Array }>;
  negatives: Float32Array[];
};

/** One cache entry per CLIP model: the prompts are the same text for every photo and every owner. */
const PROMPT_CACHE = new Map<string, Promise<PromptEmbeddings>>();

export const clearPetPromptCache = () => PROMPT_CACHE.clear();

/** Where pet recognition stands for one owner, without contacting any worker. */
export type PetRecognitionStatus = {
  available: boolean;
  reason: PetRecognitionUnavailableReason | null;
  detail: string | null;
  destination: { kind: MlDestinationKind; name: string } | null;
  hasConfirmedPhotos: boolean;
  run: PetRecognitionRun | null;
};

/**
 * Pet recognition with the configured CLIP model (FL-58).
 *
 * No pet-specific model exists, so recognition is built from what every install already has: the
 * CLIP image embedding smart search stored for each photo, and CLIP text embeddings of a few
 * prompts, encoded on the destination the administrator routed `pet-recognition` to (FL-110). It
 * never picks another destination: an unrouted, disabled, unconsented or unhealthy destination is
 * a refusal with a reason the Pets page shows.
 *
 * 1. Species gate: zero-shot CLIP ("a photo of a cat", "a photo of a dog", … against people,
 *    landscapes, food, documents). A photo that does not read as an animal gets no detection.
 * 2. Identity: nearest neighbours of the photo's embedding among the photos the owner confirmed
 *    each of their pets in, compatible species only.
 *
 * The result is a whole-photo `pet_detection` (CLIP cannot place a box) with scored `pet_candidate`
 * proposals. Only the replaceable side is written: `pet` and `pet_observation` are never touched,
 * pairs the owner answered are never proposed again, and nothing is ever confirmed without the
 * owner, however confident the match.
 */
@Injectable()
export class PetRecognitionService {
  constructor(
    private logger: LoggingRepository,
    private petRepository: PetRepository,
    private mlDestinationRepository: MlDestinationRepository,
    private machineLearningRepository: MachineLearningRepository,
    private jobRepository: JobRepository,
    private configRepository: ConfigRepository,
    private systemMetadataRepository: SystemMetadataRepository,
  ) {
    this.logger.setContext(PetRecognitionService.name);
  }

  // ------------------------------------------------------------------------------ status

  /**
   * Whether recognition can run for this owner, from configuration and the destination's stored
   * check only. The reason is the same admission refusal the job would meet, so the Pets page never
   * promises what the job would refuse.
   */
  async getStatus(ownerId: string): Promise<PetRecognitionStatus> {
    const [config, run, hasConfirmedPhotos] = await Promise.all([
      this.config(),
      this.petRepository.getRun(ownerId),
      this.petRepository.hasConfirmedObservations(ownerId),
    ]);
    const base = { hasConfirmedPhotos, run: run ?? null };
    const refuse = (
      reason: PetRecognitionUnavailableReason,
      detail: string,
      destination: PetRecognitionStatus['destination'] = null,
    ): PetRecognitionStatus => ({ ...base, available: false, reason, detail, destination });

    if (!isMachineLearningEnabled(config.machineLearning)) {
      return refuse(PetRecognitionUnavailableReason.MachineLearningDisabled, 'machine learning is turned off');
    }
    if (!isSmartSearchEnabled(config.machineLearning)) {
      return refuse(PetRecognitionUnavailableReason.SmartSearchDisabled, 'smart search is turned off');
    }

    const route = await this.mlDestinationRepository.getRoute(MlWorkload.PetRecognition);
    if (!route) {
      return refuse(
        PetRecognitionUnavailableReason.WorkloadNotRouted,
        `no destination is routed for ${MlWorkload.PetRecognition}`,
      );
    }

    const destination = await this.mlDestinationRepository.getById(route.destinationId);
    const endpoint = destination ? resolveEndpoint(destination) : null;
    const spentUsd =
      destination && destination.budgetLimitUsd !== null
        ? await this.mlDestinationRepository.getSpend(
            destination.id,
            new Date(Date.now() - ML_BUDGET_WINDOW_DAYS * 24 * 60 * 60 * 1000),
          )
        : 0;
    const verdict = evaluateAdmission({
      destination,
      workload: MlWorkload.PetRecognition,
      endpoint,
      probe: destination ? storedProbe(destination) : null,
      spentUsd,
    });
    const named = destination ? { kind: destination.kind, name: destination.name } : null;
    if (!verdict.admitted) {
      return refuse(asUnavailableReason(verdict.refusal), verdict.detail, named);
    }
    return { ...base, available: true, reason: null, detail: null, destination: named };
  }

  // ------------------------------------------------------------------------------- runs

  /** The owner asked to look through their library again. A running run is replaced. */
  async startRun(ownerId: string, destinationKind: MlDestinationKind | null): Promise<PetRecognitionRun> {
    const run = await this.petRepository.startRun(ownerId, destinationKind);
    await this.jobRepository.queue({ name: JobName.PetRecognitionQueueAll, data: { userId: ownerId } });
    return run;
  }

  cancelRun(ownerId: string): Promise<PetRecognitionRun | undefined> {
    return this.petRepository.cancelRun(ownerId);
  }

  /**
   * A run write from a job during a database handoff: the run table is fork-owned and refuses
   * (ConflictException); the job logs it and leaves the run as it is instead of failing. The owner's
   * own start and cancel answer 409 instead.
   */
  private async duringForkWrites<T>(what: string, write: () => Promise<T>): Promise<T | undefined> {
    try {
      return await write();
    } catch (error) {
      if (!(error instanceof ConflictException)) {
        throw error;
      }
      this.logger.warn(`Did not ${what} during a database handoff`);
      return undefined;
    }
  }

  // ------------------------------------------------------------------------------- jobs

  /**
   * An owner's run (`userId`), or the administrator's run over every owner who has confirmed a pet
   * (Job manager "Pet recognition"). Each owner's photos with a CLIP embedding are queued with the
   * owner's run id, so a cancel reaches the jobs still waiting.
   */
  @OnJob({ name: JobName.PetRecognitionQueueAll, queue: QueueName.PetRecognition })
  async handleQueueAll({ userId }: JobOf<JobName.PetRecognitionQueueAll>): Promise<JobStatus> {
    const { machineLearning } = await this.config(false);
    if (!isSmartSearchEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    const owners = userId ? [userId] : await this.petRepository.getOwnersWithConfirmedPets();
    for (const ownerId of owners) {
      const run = userId
        ? await this.petRepository.getRun(ownerId)
        : await this.duringForkWrites('start a pet recognition run', () => this.petRepository.startRun(ownerId, null));
      if (!run || !(await this.petRepository.isRunActive(run.id))) {
        continue;
      }

      const assetIds = await this.petRepository.getRecognizableAssetIds(ownerId);
      const counted = await this.duringForkWrites('count a pet recognition run', async () => {
        await this.petRepository.setRunAssets(run.id, assetIds.length);
        return true;
      });
      if (!counted) {
        continue;
      }
      for (let index = 0; index < assetIds.length; index += QUEUE_BATCH) {
        await this.jobRepository.queueAll(
          assetIds
            .slice(index, index + QUEUE_BATCH)
            .map((id) => ({ name: JobName.PetRecognition, data: { id, runId: run.id } })),
        );
      }
    }

    return JobStatus.Success;
  }

  /** A pet was confirmed in a photo: look again at the owner's photos most like it (bounded). */
  @OnJob({ name: JobName.PetRecognitionNearest, queue: QueueName.PetRecognition })
  async handleNearest({ petId, assetId }: JobOf<JobName.PetRecognitionNearest>): Promise<JobStatus> {
    const asset = await this.petRepository.getRecognitionAsset(assetId);
    const [pet] = asset ? await this.petRepository.getByIds(asset.ownerId, [petId]) : [];
    if (!asset || !pet) {
      return JobStatus.Skipped;
    }

    const ids = await this.petRepository.getNearestAssetIds(asset.ownerId, assetId, PET_NEAREST_ASSET_LIMIT);
    await this.jobRepository.queueAll(ids.map((id) => ({ name: JobName.PetRecognition, data: { id } })));
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.PetRecognition, queue: QueueName.PetRecognition })
  async handleRecognize({ id, runId }: JobOf<JobName.PetRecognition>): Promise<JobStatus> {
    if (runId && !(await this.petRepository.isRunActive(runId))) {
      return JobStatus.Skipped;
    }

    const { status, proposals } = await this.recognize(id, runId ?? null);
    if (runId && status !== JobStatus.Failed) {
      await this.duringForkWrites('record pet recognition progress', () =>
        this.petRepository.recordRunProgress(runId, proposals),
      );
    }
    return status;
  }

  private async recognize(assetId: string, runId: string | null): Promise<{ status: JobStatus; proposals: number }> {
    const done = (status: JobStatus, proposals = 0) => ({ status, proposals });
    const { machineLearning } = await this.config();
    if (!isSmartSearchEnabled(machineLearning)) {
      return done(JobStatus.Skipped);
    }

    const asset = await this.petRepository.getRecognitionAsset(assetId);
    if (!asset || asset.deletedAt || asset.visibility === AssetVisibility.Hidden) {
      return done(JobStatus.Skipped);
    }

    const references = await this.getReferences(asset.ownerId, asset.id);
    const run = petRecognitionRun(machineLearning.clip.modelName);
    const existing = await this.petRepository.getDetectionsForAsset(asset.id);
    const { allIds } = detectionsToReplace(existing, run);

    if (references.length === 0) {
      // Nothing to recognise against: clear what an earlier revision proposed, send nothing anywhere.
      if (allIds.length > 0) {
        await this.petRepository.replaceDetections(asset.id, allIds, []);
      }
      return done(JobStatus.Skipped);
    }

    const vector = parseEmbedding(asset.embedding);
    if (!vector) {
      return done(JobStatus.Skipped);
    }
    const embedding = l2Normalize(vector);

    let selection: MlSelection;
    try {
      const destinationId = await routedMlDestinationId(this.mlDestinationRepository, MlWorkload.PetRecognition);
      selection = await selectMlDestination(
        {
          mlDestinationRepository: this.mlDestinationRepository,
          machineLearningRepository: this.machineLearningRepository,
        },
        { workload: MlWorkload.PetRecognition, destinationId, jobId: asset.id, jobName: JobName.PetRecognition },
      );
    } catch (error) {
      if (error instanceof MlDestinationRefusedError || error instanceof MlDestinationNotFoundError) {
        this.logger.warn(`Pet recognition for ${asset.id} refused: ${error.message}`);
        if (runId) {
          await this.duringForkWrites('fail a pet recognition run', () =>
            this.petRepository.failRun(runId, error.message),
          );
        }
        return done(JobStatus.Failed);
      }
      throw error;
    }

    const prompts = await this.getPromptEmbeddings(selection, machineLearning.clip.modelName);
    const reading = readSpecies(embedding, prompts.species, prompts.negatives);
    if (reading.species === null) {
      await this.petRepository.replaceDetections(asset.id, allIds, []);
      return done(JobStatus.Success);
    }

    const answered = new Set(
      (await this.petRepository.getDecisionsForAsset(asset.ownerId, asset.id)).map(({ petId }) => petId),
    );
    const matches = matchPets(embedding, reading, references, answered);
    const width = asset.width ?? asset.exifImageWidth ?? 0;
    const height = asset.height ?? asset.exifImageHeight ?? 0;
    const [detection] = await this.petRepository.replaceDetections(asset.id, allIds, [
      {
        // CLIP reads the whole photo; it cannot place the animal (FL-145 carries per-region detection).
        boundingBoxX1: 0,
        boundingBoxY1: 0,
        boundingBoxX2: width,
        boundingBoxY2: height,
        imageWidth: width,
        imageHeight: height,
        species: reading.species,
        score: reading.animalProbability,
        modelName: run.modelName,
        modelRevision: run.modelRevision,
      },
    ]);

    if (detection && matches.length > 0) {
      await this.petRepository.upsertCandidates(
        matches.map(({ petId, score }) => ({ detectionId: detection.id, petId, score })),
      );
    }
    return done(JobStatus.Success, matches.length);
  }

  // ---------------------------------------------------------------------------- events

  /**
   * An original was replaced or changed (FL-58 source checksums): drawn regions made on the old one
   * are flagged for review. The model side is replaced when smart search re-encodes the photo.
   */
  @OnEvent({ name: 'AssetMetadataExtracted', workers: [ImmichWorker.Microservices] })
  async onAssetMetadataExtracted({ assetId }: ArgOf<'AssetMetadataExtracted'>) {
    const flagged = await this.petRepository.flagStaleRegions(assetId);
    if (flagged > 0) {
      this.logger.log(`Asset ${assetId} changed; ${flagged} pet region(s) flagged for review`);
    }
  }

  // --------------------------------------------------------------------------- helpers

  private async getReferences(ownerId: string, assetId: string): Promise<PetReference[]> {
    const rows = await this.petRepository.getRecognitionReferences(
      ownerId,
      assetId,
      PET_RECOGNITION_THRESHOLDS.referencesPerPet,
    );
    const byPet = new Map<string, PetReference>();
    for (const row of rows) {
      const vector = parseEmbedding(row.embedding);
      if (!vector) {
        continue;
      }
      const entry = byPet.get(row.petId) ?? { petId: row.petId, species: row.species, embeddings: [] };
      entry.embeddings.push(l2Normalize(vector));
      byPet.set(row.petId, entry);
    }
    return byPet.values().toArray();
  }

  private getPromptEmbeddings(selection: MlSelection, modelName: string): Promise<PromptEmbeddings> {
    const cached = PROMPT_CACHE.get(modelName);
    if (cached) {
      return cached;
    }
    const promise = this.encodePrompts(selection, modelName).catch((error) => {
      PROMPT_CACHE.delete(modelName);
      throw error;
    });
    PROMPT_CACHE.set(modelName, promise);
    return promise;
  }

  private async encodePrompts(selection: MlSelection, modelName: string): Promise<PromptEmbeddings> {
    const encode = async (text: string) => {
      const vector = parseEmbedding(await this.machineLearningRepository.encodeText(selection, text, { modelName }));
      if (!vector) {
        throw new Error(`The CLIP model ${modelName} returned no embedding for "${text}"`);
      }
      return l2Normalize(vector);
    };
    const species = [];
    for (const { species: name, prompt } of PET_SPECIES_PROMPTS) {
      species.push({ species: name, embedding: await encode(prompt) });
    }
    const negatives = [];
    for (const prompt of PET_NEGATIVE_PROMPTS) {
      negatives.push(await encode(prompt));
    }
    return { species, negatives };
  }

  private config(withCache = true) {
    return getConfig(
      { configRepo: this.configRepository, metadataRepo: this.systemMetadataRepository, logger: this.logger },
      { withCache },
    );
  }
}

/** FL-110 refusals are pet recognition's destination reasons, value for value. */
export const asUnavailableReason = (refusal: MlAdmissionRefusal): PetRecognitionUnavailableReason =>
  refusal as unknown as PetRecognitionUnavailableReason;
