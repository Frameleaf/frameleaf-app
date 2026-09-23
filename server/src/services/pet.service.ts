import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  PetCandidateListResponseDto,
  PetCandidateReviewDto,
  PetCandidateSearchDto,
  PetCreateDto,
  PetMergeDto,
  PetObservationCreateDto,
  PetObservationResponseDto,
  PetResponseDto,
  PetSearchDto,
  PetUpdateDto,
  mapPet,
  mapPetCandidate,
  mapPetObservation,
} from 'src/dtos/pet.dto.js';
import { PetObservationSource, PetObservationState, Permission } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PetRepository } from 'src/repositories/pet.repository.js';
import { requireAccess } from 'src/utils/access.js';
import { getHiddenContentQueryOptions, isSuppressedWhileLocked } from 'src/utils/hidden-content.js';
import { getLockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import {
  filterReviewedCandidates,
  normalizePetName,
  planObservationMerge,
  sortCandidatesForReview,
} from 'src/utils/pets.js';

/**
 * Why the queue is empty while no pet model exists.
 *
 * `machine-learning/immich_ml` implements no `pet-recognition` task, so the review page
 * must not claim that an empty queue means everything has been reviewed. This reason is
 * returned with every candidate listing and shown to the user verbatim through an i18n
 * key, so the page is honest about the difference between "nothing to review" and
 * "nothing can propose anything yet".
 */
export const PET_RECOGNITION_UNAVAILABLE_REASON = 'no_model';

@Injectable()
export class PetService {
  constructor(
    private accessRepository: AccessRepository,
    private petRepository: PetRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(PetService.name);
  }

  // ------------------------------------------------------------------------- identity

  async getAll(auth: AuthDto, dto: PetSearchDto): Promise<PetResponseDto[]> {
    // FL-58: suppressed pets, like suppressed people and tags, stay out of a session that is not unlocked;
    // FL-34: photo counts include the caller's Locked media only in their elevated session
    const pets = await this.petRepository.getAll(auth.user.id, {
      withHidden: dto.withHidden ?? false,
      ...getHiddenContentQueryOptions(auth),
      ...getLockedVisibilityOptions(auth),
    });
    return pets.map((pet) => mapPet(pet));
  }

  async get(auth: AuthDto, id: string): Promise<PetResponseDto> {
    return mapPet(await this.findOrFail(auth, id));
  }

  async create(auth: AuthDto, dto: PetCreateDto): Promise<PetResponseDto> {
    const featuredAssetId = await this.resolveFeaturedAsset(auth, dto.featuredAssetId);

    const created = await this.petRepository.create({
      ownerId: auth.user.id,
      name: normalizePetName(dto.name ?? ''),
      species: dto.species,
      birthDate: dto.birthDate ?? null,
      featuredAssetId,
      isHidden: dto.isHidden ?? false,
      isFavorite: dto.isFavorite ?? false,
    });

    return mapPet({ ...created, assetCount: 0 });
  }

  async update(auth: AuthDto, id: string, dto: PetUpdateDto): Promise<PetResponseDto> {
    const pet = await this.findOrFail(auth, id);

    const featuredAssetId =
      dto.featuredAssetId === undefined ? undefined : await this.resolveFeaturedAsset(auth, dto.featuredAssetId);

    await this.petRepository.update(auth.user.id, pet.id, {
      ...(dto.name === undefined ? {} : { name: normalizePetName(dto.name) }),
      ...(dto.species === undefined ? {} : { species: dto.species }),
      ...(dto.birthDate === undefined ? {} : { birthDate: dto.birthDate }),
      ...(featuredAssetId === undefined ? {} : { featuredAssetId }),
      ...(dto.isHidden === undefined ? {} : { isHidden: dto.isHidden }),
      ...(dto.isFavorite === undefined ? {} : { isFavorite: dto.isFavorite }),
    });

    return mapPet(await this.findOrFail(auth, id));
  }

  async remove(auth: AuthDto, id: string): Promise<void> {
    await this.findOrFail(auth, id);
    await this.petRepository.delete(auth.user.id, id);
  }

  /**
   * Merge other pets into this one.
   *
   * The durable observations move; the conflict rule is `planObservationMerge`. The
   * candidates of the pets that disappear go with them, because they are proposals about
   * an identity that no longer exists and the model will propose again.
   */
  async merge(auth: AuthDto, id: string, dto: PetMergeDto): Promise<PetResponseDto> {
    const target = await this.findOrFail(auth, id);

    const sourceIds = [...new Set(dto.ids)].filter((sourceId) => sourceId !== target.id);
    if (sourceIds.length === 0) {
      throw new BadRequestException('Cannot merge a pet into itself');
    }

    const sources = await this.petRepository.getByIds(auth.user.id, sourceIds);
    if (
      sources.length !== sourceIds.length ||
      sourceIds.some((sourceId) => isSuppressedWhileLocked(auth, 'pet', sourceId))
    ) {
      // Owner-scoped lookup: a missing row is either gone or someone else's, and the
      // caller is told the same thing either way. A pet suppressed while the session is
      // not unlocked is told the same again.
      throw new BadRequestException('Pet not found');
    }

    for (const source of sources) {
      const [sourceObservations, targetObservations] = await Promise.all([
        // a merge moves every observation, Locked ones included; nothing here is returned
        this.petRepository.getObservations(auth.user.id, source.id, { withLocked: true }),
        this.petRepository.getObservations(auth.user.id, target.id, { withLocked: true }),
      ]);

      const plan = planObservationMerge(sourceObservations, targetObservations);
      await this.petRepository.mergeInto(auth.user.id, {
        sourceId: source.id,
        targetId: target.id,
        ...plan,
      });
    }

    return mapPet(await this.findOrFail(auth, id));
  }

  // --------------------------------------------------------------- durable observations

  async getObservations(auth: AuthDto, id: string): Promise<PetObservationResponseDto[]> {
    await this.findOrFail(auth, id);
    const observations = await this.petRepository.getObservations(auth.user.id, id, getLockedVisibilityOptions(auth));
    return observations.map((observation) => mapPetObservation(observation));
  }

  /**
   * Say by hand that a pet is in an asset, optionally with a drawn region.
   *
   * The asset goes through the normal access check before anything is written, so this
   * cannot annotate a photo the account may only see through an album or a partner.
   */
  async addObservation(auth: AuthDto, id: string, dto: PetObservationCreateDto): Promise<PetObservationResponseDto> {
    const pet = await this.findOrFail(auth, id);
    await requireAccess(this.accessRepository, {
      auth,
      permission: Permission.AssetUpdate,
      ids: [dto.assetId],
    });

    const box = this.validateRegion(dto);

    const observation = await this.petRepository.upsertObservation({
      petId: pet.id,
      assetId: dto.assetId,
      state: PetObservationState.Confirmed,
      source: PetObservationSource.Manual,
      ...box,
    });

    return mapPetObservation(observation);
  }

  /** Undo a durable decision. Nothing else removes one. */
  async removeObservation(auth: AuthDto, observationId: string): Promise<void> {
    const observation = await this.petRepository.getObservationById(
      auth.user.id,
      observationId,
      getLockedVisibilityOptions(auth),
    );
    if (!observation || isSuppressedWhileLocked(auth, 'pet', observation.petId)) {
      throw new NotFoundException('Pet observation not found');
    }

    await this.petRepository.deleteObservation(auth.user.id, observationId);
  }

  // ------------------------------------------------------------------------ review flow

  async getCandidates(auth: AuthDto, dto: PetCandidateSearchDto): Promise<PetCandidateListResponseDto> {
    const [candidates, decisions] = await Promise.all([
      this.petRepository.getCandidates(auth.user.id, dto.size, getLockedVisibilityOptions(auth)),
      this.petRepository.getDecisions(auth.user.id),
    ]);

    // A pairing the owner has already answered never comes back, whatever model revision
    // proposed it this time. A proposal naming a pet suppressed while the session is not
    // unlocked stays out too, since the pet itself is not there.
    const unreviewed = sortCandidatesForReview(
      filterReviewedCandidates(
        candidates.filter((candidate) => !isSuppressedWhileLocked(auth, 'pet', candidate.petId)),
        decisions,
      ),
    );

    return {
      candidates: unreviewed.map((candidate) => mapPetCandidate(candidate)),
      recognitionAvailable: false,
      recognitionUnavailableReason: PET_RECOGNITION_UNAVAILABLE_REASON,
    };
  }

  /**
   * Accept a proposal, or reassign it to a different pet.
   *
   * Either way the result is one durable `confirmed` observation carrying the detected
   * region, and every proposal about that detection is dropped: the model has had its
   * say and the owner has answered.
   */
  async acceptCandidate(
    auth: AuthDto,
    candidateId: string,
    dto: PetCandidateReviewDto,
  ): Promise<PetObservationResponseDto> {
    const candidate = await this.findCandidateOrFail(auth, candidateId);
    const petId = dto.petId ?? candidate.petId;

    // Reassignment targets a pet the caller names, so it gets its own owner check.
    await this.findOrFail(auth, petId);

    const observation = await this.petRepository.upsertObservation({
      petId,
      assetId: candidate.assetId,
      state: PetObservationState.Confirmed,
      source: PetObservationSource.Review,
      boundingBoxX1: candidate.boundingBoxX1,
      boundingBoxY1: candidate.boundingBoxY1,
      boundingBoxX2: candidate.boundingBoxX2,
      boundingBoxY2: candidate.boundingBoxY2,
      imageWidth: candidate.imageWidth,
      imageHeight: candidate.imageHeight,
    });

    await this.petRepository.deleteCandidatesForDetection(candidate.detectionId);

    return mapPetObservation(observation);
  }

  /**
   * Reject a proposal.
   *
   * The rejection is stored as a durable `rejected` observation rather than by deleting
   * the candidate alone. Deleting alone would be forgotten the moment the model ran
   * again; the durable row is what keeps the pairing out of the queue across revisions.
   */
  async rejectCandidate(auth: AuthDto, candidateId: string): Promise<PetObservationResponseDto> {
    const candidate = await this.findCandidateOrFail(auth, candidateId);

    const observation = await this.petRepository.upsertObservation({
      petId: candidate.petId,
      assetId: candidate.assetId,
      state: PetObservationState.Rejected,
      source: PetObservationSource.Review,
      boundingBoxX1: null,
      boundingBoxY1: null,
      boundingBoxX2: null,
      boundingBoxY2: null,
      imageWidth: null,
      imageHeight: null,
    });

    await this.petRepository.deleteCandidatesForDetection(candidate.detectionId);

    return mapPetObservation(observation);
  }

  // ---------------------------------------------------------------------------- helpers

  /**
   * Every read and write of one pet comes through here. While the session is not unlocked a
   * suppressed pet answers exactly like a missing one (owner decision, September 22, 2026).
   */
  private async findOrFail(auth: AuthDto, id: string) {
    if (isSuppressedWhileLocked(auth, 'pet', id)) {
      throw new NotFoundException('Pet not found');
    }

    const pet = await this.petRepository.getById(auth.user.id, id, getLockedVisibilityOptions(auth));
    if (!pet) {
      throw new NotFoundException('Pet not found');
    }
    return pet;
  }

  private async findCandidateOrFail(auth: AuthDto, id: string) {
    const candidate = await this.petRepository.getCandidateById(auth.user.id, id, getLockedVisibilityOptions(auth));
    if (!candidate || isSuppressedWhileLocked(auth, 'pet', candidate.petId)) {
      throw new NotFoundException('Pet recognition candidate not found');
    }
    return candidate;
  }

  /**
   * A featured photo must be one this account owns, or nothing. Callers that mean "leave
   * it alone" must not call this at all; a missing value here means "clear it".
   *
   * A Locked photo is never a featured photo (FL-53): the pet's thumbnail shows on the pets
   * page and in search whatever the session. Only the owner's own asset gets this far, so
   * the refusal can say why.
   */
  private async resolveFeaturedAsset(auth: AuthDto, assetId: string | null | undefined) {
    if (assetId === null || assetId === undefined) {
      return null;
    }

    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetUpdate, ids: [assetId] });
    if (await this.petRepository.isOwnLockedAsset(auth.user.id, assetId)) {
      throw new BadRequestException('A Locked photo cannot be a featured photo');
    }

    return assetId;
  }

  private validateRegion(dto: PetObservationCreateDto) {
    const parts = [
      dto.boundingBoxX1,
      dto.boundingBoxY1,
      dto.boundingBoxX2,
      dto.boundingBoxY2,
      dto.imageWidth,
      dto.imageHeight,
    ];

    if (parts.every((part) => part === undefined)) {
      // Naming a whole photo is a real answer, and the keyboard alternative to drawing.
      return {
        boundingBoxX1: null,
        boundingBoxY1: null,
        boundingBoxX2: null,
        boundingBoxY2: null,
        imageWidth: null,
        imageHeight: null,
      };
    }

    if (parts.some((part) => part === undefined)) {
      throw new BadRequestException('A pet region needs all four bounds and the image size');
    }

    const { boundingBoxX1, boundingBoxY1, boundingBoxX2, boundingBoxY2, imageWidth, imageHeight } =
      dto as Required<PetObservationCreateDto>;

    if (boundingBoxX2 <= boundingBoxX1 || boundingBoxY2 <= boundingBoxY1) {
      throw new BadRequestException('A pet region must have a positive width and height');
    }

    if (boundingBoxX2 > imageWidth || boundingBoxY2 > imageHeight) {
      throw new BadRequestException('A pet region must fall inside the image');
    }

    return { boundingBoxX1, boundingBoxY1, boundingBoxX2, boundingBoxY2, imageWidth, imageHeight };
  }
}
