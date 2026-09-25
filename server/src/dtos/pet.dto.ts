import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import type {
  PetObservation,
  PetRecognitionRun,
  PetReviewCandidate,
  PetWithCounts,
} from 'src/repositories/pet.repository.js';
import type { PetRecognitionStatus } from 'src/services/pet-recognition.service.js';
import {
  MlDestinationKindSchema,
  PetObservationSourceSchema,
  PetObservationStateSchema,
  PetRecognitionRunStatusSchema,
  PetRecognitionUnavailableReasonSchema,
  PetSpecies,
  PetSpeciesSchema,
} from 'src/enum.js';
import { asDateString, asDateTimeString } from 'src/utils/date.js';
import { PET_NAME_MAX_LENGTH } from 'src/utils/pets.js';
import { stringToBool } from 'src/validation.js';

/**
 * Pet contracts (FL-58).
 *
 * The split in the schema shows up here too: `PetResponseDto` is the durable identity,
 * `PetObservationResponseDto` is a durable decision, and `PetCandidateResponseDto` is a
 * model proposal that carries the model name and revision that produced it, so a client
 * can say honestly where a suggestion came from.
 */

const birthDate = z
  .string()
  .meta({ format: 'date' })
  .nullable()
  .refine((value) => (value ? new Date(value) <= new Date() : true), { error: 'Birth date cannot be in the future' })
  .describe('Pet date of birth');

const PetCreateSchema = z
  .object({
    name: z.string().max(PET_NAME_MAX_LENGTH).optional().describe('Pet name'),
    species: PetSpeciesSchema.default(PetSpecies.Other),
    birthDate: birthDate.optional(),
    featuredAssetId: z.uuidv4().nullable().optional().describe('Asset used as the pet thumbnail'),
    isHidden: z.boolean().optional().describe('Pet visibility (hidden)'),
    isFavorite: z.boolean().optional().describe('Mark as favorite'),
  })
  .meta({ id: 'PetCreateDto' });

const PetUpdateSchema = z
  .object({
    name: z.string().max(PET_NAME_MAX_LENGTH).optional().describe('Pet name'),
    species: PetSpeciesSchema.optional(),
    birthDate: birthDate.optional(),
    featuredAssetId: z.uuidv4().nullable().optional().describe('Asset used as the pet thumbnail'),
    isHidden: z.boolean().optional().describe('Pet visibility (hidden)'),
    isFavorite: z.boolean().optional().describe('Mark as favorite'),
  })
  .meta({ id: 'PetUpdateDto' });

const PetSearchSchema = z
  .object({
    withHidden: stringToBool.optional().describe('Include hidden pets'),
  })
  .meta({ id: 'PetSearchDto' });

const PetMergeSchema = z
  .object({
    ids: z.array(z.uuidv4()).min(1).describe('Pet IDs to merge into this pet'),
  })
  .meta({ id: 'PetMergeDto' });

/**
 * FL-58: the checksum of the original the client was looking at (the asset's `checksum`, base64).
 * When it is supplied and the original has since been replaced, the write is refused with 409 so a
 * region drawn on the old photo never lands on the new one.
 */
const expectedChecksum = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe('Checksum of the original the decision was made on (base64); refused with 409 when it changed');

const PetObservationCreateSchema = z
  .object({
    assetId: z.uuidv4().describe('Asset the pet appears in'),
    expectedChecksum,
    boundingBoxX1: z.int().min(0).optional().describe('Region X1, in source pixels'),
    boundingBoxY1: z.int().min(0).optional().describe('Region Y1, in source pixels'),
    boundingBoxX2: z.int().min(0).optional().describe('Region X2, in source pixels'),
    boundingBoxY2: z.int().min(0).optional().describe('Region Y2, in source pixels'),
    imageWidth: z.int().min(1).optional().describe('Width of the image the region was drawn on'),
    imageHeight: z.int().min(1).optional().describe('Height of the image the region was drawn on'),
  })
  .meta({ id: 'PetObservationCreateDto' });

const PetCandidateReviewSchema = z
  .object({
    // Omitted means "the pet that was proposed"; supplying a different pet is the
    // reassign case, which is still one durable decision.
    petId: z.uuidv4().optional().describe('Pet to assign instead of the proposed one'),
    expectedChecksum,
  })
  .meta({ id: 'PetCandidateReviewDto' });

const PetCandidateRejectSchema = z.object({ expectedChecksum }).meta({ id: 'PetCandidateRejectDto' });

const PetObservationDeleteSchema = z.object({ expectedChecksum }).meta({ id: 'PetObservationDeleteDto' });

const PetAssetObservationSearchSchema = z
  .object({ assetId: z.uuidv4().describe('Asset whose pet observations to list') })
  .meta({ id: 'PetAssetObservationSearchDto' });

const PetCandidateSearchSchema = z
  .object({
    size: z.coerce.number().int().min(1).max(500).default(100).describe('Number of candidates to return'),
  })
  .meta({ id: 'PetCandidateSearchDto' });

export const PetResponseSchema = z
  .object({
    id: z.uuidv4().describe('Pet ID'),
    name: z.string().describe('Pet name'),
    species: PetSpeciesSchema,
    birthDate: z.string().meta({ format: 'date' }).nullable().describe('Pet date of birth'),
    featuredAssetId: z.uuidv4().nullable().describe('Asset used as the pet thumbnail'),
    isHidden: z.boolean().describe('Is hidden'),
    isFavorite: z.boolean().describe('Is favorite'),
    assetCount: z.int().min(0).describe('Number of assets with a confirmed observation of this pet'),
    createdAt: z.string().meta({ format: 'date-time' }).describe('Creation date'),
    updatedAt: z.string().meta({ format: 'date-time' }).describe('Last update date'),
  })
  .meta({ id: 'PetResponseDto' });

export const PetObservationResponseSchema = z
  .object({
    id: z.uuidv4().describe('Observation ID'),
    petId: z.uuidv4().describe('Pet ID'),
    assetId: z.uuidv4().describe('Asset ID'),
    state: PetObservationStateSchema,
    source: PetObservationSourceSchema,
    boundingBoxX1: z.int().nullable().describe('Region X1, in source pixels'),
    boundingBoxY1: z.int().nullable().describe('Region Y1, in source pixels'),
    boundingBoxX2: z.int().nullable().describe('Region X2, in source pixels'),
    boundingBoxY2: z.int().nullable().describe('Region Y2, in source pixels'),
    imageWidth: z.int().nullable().describe('Width of the image the region was drawn on'),
    imageHeight: z.int().nullable().describe('Height of the image the region was drawn on'),
    sourceChecksum: z
      .string()
      .nullable()
      .describe('Checksum (base64) of the original when the decision was made; null for older decisions'),
    staleAt: z
      .string()
      .meta({ format: 'date-time' })
      .nullable()
      .describe('When the original was replaced under a drawn region, which then needs review; null when current'),
    createdAt: z.string().meta({ format: 'date-time' }).describe('Creation date'),
    updatedAt: z.string().meta({ format: 'date-time' }).describe('Last update date'),
  })
  .meta({ id: 'PetObservationResponseDto' });

export const PetCandidateResponseSchema = z
  .object({
    id: z.uuidv4().describe('Candidate ID'),
    petId: z.uuidv4().describe('Proposed pet ID'),
    assetId: z.uuidv4().describe('Asset the proposal is about'),
    assetChecksum: z.string().describe('Checksum (base64) of the asset now; send it back as expectedChecksum'),
    score: z.number().meta({ format: 'double' }).describe('Model confidence, 0 to 1'),
    detectedSpecies: z.string().nullable().describe("The detector's species guess, which is never the pet's species"),
    modelName: z.string().describe('Model that produced the detection'),
    modelRevision: z.string().describe('Revision of the model that produced the detection'),
    boundingBoxX1: z.int().describe('Region X1, in source pixels'),
    boundingBoxY1: z.int().describe('Region Y1, in source pixels'),
    boundingBoxX2: z.int().describe('Region X2, in source pixels'),
    boundingBoxY2: z.int().describe('Region Y2, in source pixels'),
    imageWidth: z.int().describe('Width of the image the region was found on'),
    imageHeight: z.int().describe('Height of the image the region was found on'),
  })
  .meta({ id: 'PetCandidateResponseDto' });

export const PetRecognitionRunResponseSchema = z
  .object({
    id: z.uuidv4().describe('Run ID'),
    status: PetRecognitionRunStatusSchema,
    assetCount: z.int().min(0).describe('Photos the run looks at'),
    processedCount: z.int().min(0).describe('Photos looked at so far'),
    proposalCount: z.int().min(0).describe('Proposals made so far'),
    destinationKind: MlDestinationKindSchema.nullable().describe('Kind of destination the run was started on'),
    error: z.string().nullable().describe('Why the run stopped, when it failed'),
    createdAt: z.string().meta({ format: 'date-time' }).describe('When the run was started'),
    finishedAt: z.string().meta({ format: 'date-time' }).nullable().describe('When the run finished'),
  })
  .meta({ id: 'PetRecognitionRunResponseDto' });

export const PetRecognitionStatusResponseSchema = z
  .object({
    available: z.boolean().describe('Whether recognition can run on the routed destination now'),
    reason: PetRecognitionUnavailableReasonSchema.nullable().describe('Why it cannot; null when it can'),
    detail: z.string().nullable().describe('The refusal in words, for display'),
    destination: z
      .object({ kind: MlDestinationKindSchema, name: z.string().describe('Destination name') })
      .nullable()
      .describe('The destination pet recognition is routed to, if any'),
    hasConfirmedPhotos: z.boolean().describe('Whether any pet is confirmed in a photo, which recognition learns from'),
    run: PetRecognitionRunResponseSchema.nullable().describe('The latest run over this library'),
  })
  .meta({ id: 'PetRecognitionStatusResponseDto' });

export const PetCandidateListResponseSchema = z
  .object({
    candidates: z.array(PetCandidateResponseSchema).describe('Proposals awaiting review'),
    /**
     * Honest capability reporting: false while no pet recognition model is installed, so
     * the client can say "no candidates yet" for the right reason instead of implying an
     * empty queue means everything has been reviewed.
     */
    recognitionAvailable: z.boolean().describe('Whether a pet recognition model is configured and available'),
    recognitionUnavailableReason: z
      .string()
      .nullable()
      .describe('Why recognition is unavailable, for display; null when it is available'),
    recognition: PetRecognitionStatusResponseSchema,
  })
  .meta({ id: 'PetCandidateListResponseDto' });

export class PetCreateDto extends createZodDto(PetCreateSchema) {}
export class PetUpdateDto extends createZodDto(PetUpdateSchema) {}
export class PetSearchDto extends createZodDto(PetSearchSchema) {}
export class PetMergeDto extends createZodDto(PetMergeSchema) {}
export class PetObservationCreateDto extends createZodDto(PetObservationCreateSchema) {}
export class PetCandidateReviewDto extends createZodDto(PetCandidateReviewSchema) {}
export class PetCandidateSearchDto extends createZodDto(PetCandidateSearchSchema) {}
export class PetCandidateRejectDto extends createZodDto(PetCandidateRejectSchema) {}
export class PetObservationDeleteDto extends createZodDto(PetObservationDeleteSchema) {}
export class PetAssetObservationSearchDto extends createZodDto(PetAssetObservationSearchSchema) {}
export class PetRecognitionStatusResponseDto extends createZodDto(PetRecognitionStatusResponseSchema) {}
export class PetRecognitionRunResponseDto extends createZodDto(PetRecognitionRunResponseSchema) {}
export class PetResponseDto extends createZodDto(PetResponseSchema) {}
export class PetObservationResponseDto extends createZodDto(PetObservationResponseSchema) {}
export class PetCandidateResponseDto extends createZodDto(PetCandidateResponseSchema) {}
export class PetCandidateListResponseDto extends createZodDto(PetCandidateListResponseSchema) {}

export const mapPet = (pet: PetWithCounts): PetResponseDto => ({
  id: pet.id,
  name: pet.name,
  species: pet.species,
  birthDate: asDateString(pet.birthDate),
  featuredAssetId: pet.featuredAssetId,
  isHidden: pet.isHidden,
  isFavorite: pet.isFavorite,
  assetCount: pet.assetCount,
  createdAt: asDateTimeString(pet.createdAt),
  updatedAt: asDateTimeString(pet.updatedAt),
});

export const mapPetObservation = (observation: PetObservation): PetObservationResponseDto => ({
  id: observation.id,
  petId: observation.petId,
  assetId: observation.assetId,
  state: observation.state,
  source: observation.source,
  boundingBoxX1: observation.boundingBoxX1,
  boundingBoxY1: observation.boundingBoxY1,
  boundingBoxX2: observation.boundingBoxX2,
  boundingBoxY2: observation.boundingBoxY2,
  imageWidth: observation.imageWidth,
  imageHeight: observation.imageHeight,
  sourceChecksum: observation.sourceChecksum ? Buffer.from(observation.sourceChecksum).toString('base64') : null,
  staleAt: observation.staleAt ? asDateTimeString(observation.staleAt) : null,
  createdAt: asDateTimeString(observation.createdAt),
  updatedAt: asDateTimeString(observation.updatedAt),
});

export const mapPetRecognitionRun = (run: PetRecognitionRun): PetRecognitionRunResponseDto => ({
  id: run.id,
  status: run.status,
  assetCount: run.assetCount,
  processedCount: run.processedCount,
  proposalCount: run.proposalCount,
  destinationKind: (run.destinationKind as PetRecognitionRunResponseDto['destinationKind']) ?? null,
  error: run.error,
  createdAt: asDateTimeString(run.createdAt),
  finishedAt: run.finishedAt ? asDateTimeString(run.finishedAt) : null,
});

export const mapPetRecognitionStatus = (status: PetRecognitionStatus): PetRecognitionStatusResponseDto => ({
  available: status.available,
  reason: status.reason,
  detail: status.detail,
  destination: status.destination,
  hasConfirmedPhotos: status.hasConfirmedPhotos,
  run: status.run ? mapPetRecognitionRun(status.run) : null,
});

export const mapPetCandidate = (candidate: PetReviewCandidate): PetCandidateResponseDto => ({
  id: candidate.id,
  petId: candidate.petId,
  assetId: candidate.assetId,
  assetChecksum: Buffer.from(candidate.assetChecksum).toString('base64'),
  score: candidate.score,
  detectedSpecies: candidate.detectedSpecies,
  modelName: candidate.modelName,
  modelRevision: candidate.modelRevision,
  boundingBoxX1: candidate.boundingBoxX1,
  boundingBoxY1: candidate.boundingBoxY1,
  boundingBoxX2: candidate.boundingBoxX2,
  boundingBoxY2: candidate.boundingBoxY2,
  imageWidth: candidate.imageWidth,
  imageHeight: candidate.imageHeight,
});
