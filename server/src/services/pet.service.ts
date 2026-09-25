import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  PetAssetObservationSearchDto,
  PetCandidateListResponseDto,
  PetCandidateRejectDto,
  PetCandidateReviewDto,
  PetCandidateSearchDto,
  PetCreateDto,
  PetMergeDto,
  PetObservationCreateDto,
  PetObservationDeleteDto,
  PetObservationResponseDto,
  PetRecognitionStatusResponseDto,
  PetResponseDto,
  PetSearchDto,
  PetUpdateDto,
  mapPet,
  mapPetCandidate,
  mapPetObservation,
  mapPetRecognitionStatus,
} from 'src/dtos/pet.dto.js';
import { JobName, Permission, PetObservationSource, PetObservationState } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PetRepository } from 'src/repositories/pet.repository.js';
import { PetRecognitionService } from 'src/services/pet-recognition.service.js';
import { requireAccess } from 'src/utils/access.js';
import { getHiddenContentQueryOptions, isSuppressedWhileLocked } from 'src/utils/hidden-content.js';
import { getLockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import {
  filterReviewedCandidates,
  normalizePetName,
  planObservationMerge,
  sortCandidatesForReview,
} from 'src/utils/pets.js';

@Injectable()
export class PetService {
  constructor(
    private accessRepository: AccessRepository,
    private petRepository: PetRepository,
    private logger: LoggingRepository,
    private jobRepository: JobRepository,
    private petRecognition: PetRecognitionService,
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
      ...(dto.name !== undefined && { name: normalizePetName(dto.name) }),
      ...(dto.species !== undefined && { species: dto.species }),
      ...(dto.birthDate !== undefined && { birthDate: dto.birthDate }),
      ...(featuredAssetId !== undefined && { featuredAssetId }),
      ...(dto.isHidden !== undefined && { isHidden: dto.isHidden }),
      ...(dto.isFavorite !== undefined && { isFavorite: dto.isFavorite }),
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
    await this.requireCurrentSource(auth, dto.assetId, dto.expectedChecksum);

    const observation = await this.petRepository.upsertObservation({
      petId: pet.id,
      assetId: dto.assetId,
      state: PetObservationState.Confirmed,
      source: PetObservationSource.Manual,
      ...box,
    });

    await this.lookForPetAgain(pet.id, dto.assetId);
    return mapPetObservation(observation);
  }

  /**
   * The viewer's "Pets in this photo" (FL-58): the owner's own decisions about one asset. An asset
   * the caller cannot read is refused; on anyone else's asset the list is empty, since pets are
   * owner-only and never shared.
   */
  async getAssetObservations(auth: AuthDto, dto: PetAssetObservationSearchDto): Promise<PetObservationResponseDto[]> {
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetRead, ids: [dto.assetId] });
    const observations = await this.petRepository.getObservationsForAsset(
      auth.user.id,
      dto.assetId,
      getLockedVisibilityOptions(auth),
    );
    return observations
      .filter((observation) => !isSuppressedWhileLocked(auth, 'pet', observation.petId))
      .map((observation) => mapPetObservation(observation));
  }

  /**
   * Undo a durable decision. Nothing else removes one. The photo goes back through recognition, so
   * a proposal the owner answered by mistake comes back for review.
   */
  async removeObservation(auth: AuthDto, observationId: string, dto: PetObservationDeleteDto = {}): Promise<void> {
    const observation = await this.petRepository.getObservationById(
      auth.user.id,
      observationId,
      getLockedVisibilityOptions(auth),
    );
    if (!observation || isSuppressedWhileLocked(auth, 'pet', observation.petId)) {
      throw new NotFoundException('Pet observation not found');
    }
    await this.requireCurrentSource(auth, observation.assetId, dto.expectedChecksum);

    await this.petRepository.deleteObservation(auth.user.id, observationId);
    await this.jobRepository.queue({ name: JobName.PetRecognition, data: { id: observation.assetId } });
  }

  // ------------------------------------------------------------------ recognition runs

  async getRecognition(auth: AuthDto): Promise<PetRecognitionStatusResponseDto> {
    return mapPetRecognitionStatus(await this.petRecognition.getStatus(auth.user.id));
  }

  /**
   * Look through the owner's library again. Refused with the destination's own reason when
   * recognition cannot run, so nothing is queued that would only fail; nothing falls back.
   */
  async startRecognition(auth: AuthDto): Promise<PetRecognitionStatusResponseDto> {
    const status = await this.petRecognition.getStatus(auth.user.id);
    if (!status.available) {
      throw new BadRequestException(`Pet recognition is unavailable (${status.reason}): ${status.detail}`);
    }
    if (!status.hasConfirmedPhotos) {
      throw new BadRequestException('Confirm a pet in at least one photo first; recognition learns from those photos');
    }
    await this.petRecognition.startRun(auth.user.id, status.destination?.kind ?? null);
    return this.getRecognition(auth);
  }

  async cancelRecognition(auth: AuthDto): Promise<PetRecognitionStatusResponseDto> {
    await this.petRecognition.cancelRun(auth.user.id);
    return this.getRecognition(auth);
  }

  // ------------------------------------------------------------------------ review flow

  async getCandidates(auth: AuthDto, dto: PetCandidateSearchDto): Promise<PetCandidateListResponseDto> {
    const [candidates, decisions, recognition] = await Promise.all([
      this.petRepository.getCandidates(auth.user.id, dto.size, getLockedVisibilityOptions(auth)),
      this.petRepository.getDecisions(auth.user.id),
      this.petRecognition.getStatus(auth.user.id),
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
      recognitionAvailable: recognition.available,
      recognitionUnavailableReason: recognition.reason,
      recognition: mapPetRecognitionStatus(recognition),
    };
  }

  /**
   * Accept a proposal, or reassign it to a different pet.
   *
   * Either way the result is one durable `confirmed` observation carrying the detected
   * region. The answered proposals are dropped (the proposed pet's and, on a reassign, the
   * chosen pet's); proposals for other pets in the same photo stay for review. A reassign does
   * not record the proposed pet as absent: the owner said who this is, not who is missing.
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
    await this.requireCurrentSource(auth, candidate.assetId, dto.expectedChecksum);

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

    await this.petRepository.deleteCandidates(candidate.detectionId, [...new Set([candidate.petId, petId])]);
    await this.lookForPetAgain(petId, candidate.assetId);

    return mapPetObservation(observation);
  }

  /**
   * Reject a proposal.
   *
   * The rejection is stored as a durable `rejected` observation rather than by deleting
   * the candidate alone. Deleting alone would be forgotten the moment the model ran
   * again; the durable row is what keeps the pairing out of the queue across revisions.
   */
  async rejectCandidate(
    auth: AuthDto,
    candidateId: string,
    dto: PetCandidateRejectDto = {},
  ): Promise<PetObservationResponseDto> {
    const candidate = await this.findCandidateOrFail(auth, candidateId);
    await this.requireCurrentSource(auth, candidate.assetId, dto.expectedChecksum);

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

    await this.petRepository.deleteCandidates(candidate.detectionId, [candidate.petId]);

    return mapPetObservation(observation);
  }

  // ---------------------------------------------------------------------------- helpers

  /**
   * FL-58 source checksums: a decision made while looking at one original must not land on a
   * replacement. When the client names the checksum it saw and the asset's is different now, the
   * write is refused with 409 and the client reloads the photo. No checksum named, no check (API
   * clients that do not track the original keep working).
   */
  private async requireCurrentSource(auth: AuthDto, assetId: string, expected: string | undefined) {
    if (expected === undefined) {
      return;
    }
    const current = await this.petRepository.getOwnedAssetChecksum(auth.user.id, assetId);
    if (!current || !Buffer.from(expected, 'base64').equals(Buffer.from(current))) {
      throw new ConflictException('This photo changed since it was opened. Reload it and try again.');
    }
  }

  /** A pet was confirmed in a photo: recognition looks again at the owner's photos most like it. */
  private async lookForPetAgain(petId: string, assetId: string) {
    await this.jobRepository.queue({ name: JobName.PetRecognitionNearest, data: { petId, assetId } });
  }

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

    if (parts.includes(undefined)) {
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
