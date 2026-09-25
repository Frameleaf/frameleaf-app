import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { isUndefined, omitBy } from 'lodash-es';
import type { Insertable, Selectable, Updateable } from 'kysely';
import type { Person } from 'src/database.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { BoundingBox } from 'src/repositories/machine-learning.repository.js';
import type { FaceBoxPixels, PersonId, UpdateFacesData } from 'src/repositories/person.repository.js';
import type { AssetFaceTable } from 'src/schema/tables/asset-face.table.js';
import type { FaceSearchTable } from 'src/schema/tables/face-search.table.js';
import type { PersonTable } from 'src/schema/tables/person.table.js';
import type { JobItem, JobOf } from 'src/types.js';
import { Chunked, OnEvent, OnJob } from 'src/decorators.js';
import { BulkIdErrorReason, BulkIdResponseDto, BulkIdsDto } from 'src/dtos/asset-ids.response.dto.js';
import {
  AssetFaceBoxDto,
  AssetFaceCorrectionDto,
  AssetFaceCreateDto,
  AssetFaceDeleteDto,
  AssetFaceResponseDto,
  AssetFaceSourceResponseDto,
  AssetFaceUpdateDto,
  FaceDto,
  FaceSearchDto,
  MergePersonDto,
  MergeSuggestionsResponseDto,
  PeopleResponseDto,
  PeopleUpdateDto,
  PersonCorrectionsResponseDto,
  PersonCreateDto,
  PersonMergeSuggestionDto,
  PersonMergeVerdictCreateDto,
  PersonMergeVerdictDeleteDto,
  PersonMergeVerdictResponseDto,
  PersonResponseDto,
  PersonSearchDto,
  PersonStatisticsResponseDto,
  PersonUpdateDto,
  mapCorrection,
  mapFaces,
  mapPerson,
} from 'src/dtos/person.dto.js';
import {
  AssetVisibility,
  CacheControl,
  JobName,
  JobStatus,
  MlWorkload,
  Permission,
  PersonPathType,
  QueueName,
  SourceType,
  SystemMetadataKey,
  VectorIndex,
} from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { requireEntityAccess } from 'src/utils/access.js';
import { getDimensions } from 'src/utils/asset.util.js';
import { asDateTimeString } from 'src/utils/date.js';
import { type FaceSource, getFaceSourceRevision } from 'src/utils/face-source.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import { getHiddenContentQueryOptions, isSuppressedWhileLocked } from 'src/utils/hidden-content.js';
import { getLockedVisibilityOptions, isLockedAssetRow } from 'src/utils/locked-visibility.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { batched, isFacialRecognitionEnabled } from 'src/utils/misc.js';
import { Point, transformPoints } from 'src/utils/transform.js';

const personKey = ({ ownerId, personGroupId }: PersonId) => `${ownerId}/${personGroupId}`;

@Injectable()
export class PersonService extends BaseService {
  async getAll(auth: AuthDto, dto: PersonSearchDto): Promise<PeopleResponseDto> {
    const { withHidden = false, closestAssetId, closestPersonId, page, size } = dto;
    let closestFaceAssetId = closestAssetId;
    const pagination = {
      take: size,
      skip: (page - 1) * size,
    };

    if (closestPersonId) {
      const person = isSuppressedWhileLocked(auth, 'person', closestPersonId)
        ? undefined
        : await this.personRepository.getByGroupId({ ownerId: auth.user.id, personGroupId: closestPersonId });
      if (!person?.faceAssetId) {
        throw new NotFoundException('Person not found');
      }
      closestFaceAssetId = person.faceAssetId;
    }
    const privacyOptions = getHiddenContentQueryOptions(auth);
    const { items, hasNextPage } = await this.personRepository.getAllForUser(pagination, auth.user.id, {
      withHidden,
      closestFaceAssetId,
      ...privacyOptions,
    });
    const { total, hidden } = await this.personRepository.getNumberOfPeople(auth.user.id, privacyOptions);

    return {
      people: items.map((person) => ({
        ...mapPerson(person),
        assetCount: Number(person.assetCount),
        lastSeenAt: person.lastSeenAt ? new Date(person.lastSeenAt).toISOString() : null,
      })),
      hasNextPage,
      total,
      hidden,
    };
  }

  /**
   * FL-57: guided merge-suggestion verdict flow. Surfaces candidate pairs of people that
   * may be the same person so the People page can offer accept/reject/skip instead of
   * requiring the user to notice a duplicate on their own — FL-37's audit found no such
   * endpoint existed. Reuses the facial-recognition job's own similarity metric
   * (`machineLearning.facialRecognition.maxDistance`) rather than a second, invented
   * threshold, so a suggestion here is calibrated the same way automatic clustering is.
   *
   * "Accept" is just the existing `POST /people/merge`. "Different people" and "decide later" are
   * recorded with `setMergeVerdict`, which keeps the pair out of these suggestions (for good, or for
   * 30 days); `deleteMergeVerdict` is the undo.
   */
  async getMergeSuggestions(auth: AuthDto): Promise<MergeSuggestionsResponseDto> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    const candidates = await this.personRepository.getMergeSuggestions(auth.user.id, {
      maxDistance: machineLearning.facialRecognition.maxDistance,
      limit: 20,
    });
    if (candidates.length === 0) {
      return { suggestions: [] };
    }

    const ids = [...new Set(candidates.flatMap((candidate) => [candidate.personId, candidate.suggestionId]))];
    const people = await this.personRepository.getForMergePerson(ids);
    const byId = new Map(people.map((person) => [person.personGroupId, person]));

    const suggestions: PersonMergeSuggestionDto[] = [];
    for (const candidate of candidates) {
      // FL-37: a person suppressed while the session is not unlocked is not there, so neither is a
      // suggestion that names them
      if (
        isSuppressedWhileLocked(auth, 'person', candidate.personId) ||
        isSuppressedWhileLocked(auth, 'person', candidate.suggestionId)
      ) {
        continue;
      }

      const person = byId.get(candidate.personId);
      const suggestion = byId.get(candidate.suggestionId);
      if (person && suggestion) {
        suggestions.push({
          person: mapPerson(person),
          suggestion: mapPerson(suggestion),
          distance: candidate.distance,
        });
      }
    }

    return { suggestions };
  }

  /** FL-57: records "different people" or "decide later" for a suggested pair of the user's people. */
  async setMergeVerdict(auth: AuthDto, dto: PersonMergeVerdictCreateDto): Promise<PersonMergeVerdictResponseDto> {
    const [personId, suggestionId] = await this.requireMergePair(auth, dto);
    const { verdict, createdAt } = await this.personRepository.setMergeVerdict(
      auth.user.id,
      personId,
      suggestionId,
      dto.verdict,
    );
    return { personId, suggestionId, verdict, createdAt: asDateTimeString(createdAt) };
  }

  /** FL-57: undoes a recorded merge-suggestion verdict, so the pair can be suggested again. */
  async deleteMergeVerdict(auth: AuthDto, dto: PersonMergeVerdictDeleteDto): Promise<void> {
    const [personId, suggestionId] = await this.requireMergePair(auth, dto);
    const deleted = await this.personRepository.deleteMergeVerdict(auth.user.id, personId, suggestionId);
    if (!deleted) {
      throw new NotFoundException('Merge suggestion verdict not found');
    }
  }

  /** Both people of a pair must be the user's own (and visible to this session), stored in id order. */
  private async requireMergePair(auth: AuthDto, { personId, suggestionId }: PersonMergeVerdictDeleteDto) {
    if (personId === suggestionId) {
      throw new BadRequestException('A merge suggestion pairs two different people');
    }
    await this.requirePerson(auth, Permission.PersonRead, personId);
    await this.requirePerson(auth, Permission.PersonRead, suggestionId);
    // uuids compare bytewise in Postgres, which is the order of their lowercase hex form
    const [first, second] = [personId.toLowerCase(), suggestionId.toLowerCase()];
    return first < second ? [first, second] : [second, first];
  }

  /** A deleted account's merge-suggestion verdicts go with it (FL-57). */
  @OnEvent({ name: 'UserDelete' })
  async onUserDelete({ id }: ArgOf<'UserDelete'>) {
    await this.purgeMergeVerdicts(id);
  }

  /**
   * Verdicts naming a person that no longer exists are dropped. Like the other fork-owned writes this
   * waits out a database handoff: it is skipped then and the next cleanup catches up.
   */
  private async purgeMergeVerdicts(ownerId?: string) {
    try {
      await this.personRepository.deleteOrphanedMergeVerdicts(ownerId);
    } catch (error) {
      if (!(error instanceof ConflictException)) {
        throw error;
      }
      this.logger.warn('Skipped removing stale merge-suggestion verdicts during a database handoff');
    }
  }

  /** FL-57: correction history for a person's faces (see `PersonRepository.getCorrections`). */
  async getCorrectionHistory(auth: AuthDto, personGroupId: string): Promise<PersonCorrectionsResponseDto> {
    await this.requirePerson(auth, Permission.PersonRead, personGroupId);
    // a face on Locked media names that media's id: only its owner's elevated session sees it
    const corrections = await this.personRepository.getCorrections(personGroupId, getLockedVisibilityOptions(auth));
    return { corrections: corrections.map((face) => mapCorrection(face)) };
  }

  async reassignFaces(auth: AuthDto, personGroupId: string, dto: AssetFaceUpdateDto): Promise<PersonResponseDto[]> {
    await this.requirePerson(auth, Permission.PersonUpdate, personGroupId);
    const person = await this.findOrFail(auth, personGroupId);
    const result: PersonResponseDto[] = [];
    const changeFeaturePhoto = new Map<string, PersonId>();
    for (const data of dto.data) {
      const faces = await this.personRepository.getFacesByIds(
        [{ personGroupId: data.personId, assetId: data.assetId }],
        { viewingUserId: auth.user.id },
      );

      for (const face of faces) {
        await this.requireAccess({ auth, permission: Permission.PersonCreate, ids: [face.id] });
        if (person.faceAssetId === null) {
          changeFeaturePhoto.set(personKey(person), person);
        }
        if (face.person && face.person.faceAssetId === face.id) {
          changeFeaturePhoto.set(personKey(face.person), face.person);
        }

        await this.personRepository.reassignFace(face.id, person.personGroupId);
      }

      result.push(mapPerson(person));
    }
    if (changeFeaturePhoto.size > 0) {
      await this.createNewFeaturePhoto(changeFeaturePhoto.values().toArray());
    }
    return result;
  }

  async reassignFacesById(auth: AuthDto, personGroupId: string, dto: FaceDto): Promise<PersonResponseDto> {
    await this.requirePerson(auth, Permission.PersonUpdate, personGroupId);
    await this.requireAccess({ auth, permission: Permission.PersonCreate, ids: [dto.id] });
    const face = await this.personRepository.getFaceById(dto.id, { viewingUserId: auth.user.id });
    const person = await this.findOrFail(auth, personGroupId);

    await this.personRepository.reassignFace(face.id, person.personGroupId);
    if (person.faceAssetId === null) {
      await this.createNewFeaturePhoto([person]);
    }
    if (face.person && face.person.faceAssetId === face.id) {
      await this.createNewFeaturePhoto([face.person]);
    }

    return mapPerson(await this.findOrFail(auth, personGroupId));
  }

  async getFacesById(auth: AuthDto, dto: FaceSearchDto): Promise<AssetFaceResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [dto.id] });
    if (dto.withHidden) {
      // FL-38: hiding a face is its owner's decision, so only the owner lists hidden faces
      await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: [dto.id] });
    }
    const faces = await this.personRepository.getFaces(dto.id, {
      viewingUserId: auth.user.id,
      isVisible: true,
      withHidden: dto.withHidden,
    });
    const asset = await this.assetRepository.getForFaces(dto.id);
    const assetDimensions = getDimensions(asset);

    return faces.map((face) => mapFaces(face, auth, asset.edits, assetDimensions));
  }

  async createNewFeaturePhoto(changeFeaturePhoto: PersonId[]) {
    this.logger.debug(
      `Changing feature photos for ${changeFeaturePhoto.length} ${changeFeaturePhoto.length > 1 ? 'people' : 'person'}`,
    );

    const jobs: JobItem[] = [];
    for (const { ownerId, personGroupId } of changeFeaturePhoto) {
      const assetFace = await this.personRepository.getRandomFace(personGroupId);

      if (assetFace) {
        await this.personRepository.update({ ownerId, personGroupId, faceAssetId: assetFace.id });
        jobs.push({ name: JobName.PersonGenerateThumbnail, data: { ownerId, personGroupId } });
      }
    }

    await this.jobRepository.queueAll(jobs);
  }

  async getById(auth: AuthDto, personGroupId: string): Promise<PersonResponseDto> {
    await this.requirePerson(auth, Permission.PersonRead, personGroupId);
    return mapPerson(await this.findOrFail(auth, personGroupId));
  }

  async getStatistics(auth: AuthDto, personGroupId: string): Promise<PersonStatisticsResponseDto> {
    await this.requirePerson(auth, Permission.PersonRead, personGroupId);
    return this.personRepository.getStatistics(personGroupId, auth.user.id, getHiddenContentQueryOptions(auth));
  }

  async getThumbnail(auth: AuthDto, personGroupId: string): Promise<ImmichFileResponse> {
    await this.requirePerson(auth, Permission.PersonRead, personGroupId);
    const person = await this.personRepository.getByGroupId({ ownerId: auth.user.id, personGroupId });
    if (!person || !person.thumbnailPath) {
      throw new NotFoundException();
    }

    if (auth.hideNsfwAssets && person.faceAssetId) {
      const allowedFaces = await this.accessRepository.person.checkFaceOwnerAccess(
        auth.user.id,
        new Set([person.faceAssetId]),
        auth.hiddenContent ?? true,
      );
      if (!allowedFaces.has(person.faceAssetId)) {
        throw new NotFoundException();
      }
    }

    return new ImmichFileResponse({
      path: person.thumbnailPath,
      contentType: mimeTypes.lookup(person.thumbnailPath),
      cacheControl: CacheControl.PrivateWithoutCache,
    });
  }

  async create(auth: AuthDto, dto: PersonCreateDto): Promise<PersonResponseDto> {
    const group = await this.personRepository.createGroup(auth.user.id);
    const person = await this.personRepository.create({
      ownerId: auth.user.id,
      personGroupId: group.id,
      name: dto.name,
      birthDate: dto.birthDate,
      isHidden: dto.isHidden,
      isFavorite: dto.isFavorite,
      color: dto.color,
    });

    return mapPerson(person);
  }

  async update(auth: AuthDto, personGroupId: string, dto: PersonUpdateDto): Promise<PersonResponseDto> {
    await this.requirePerson(auth, Permission.PersonUpdate, personGroupId);

    const { ownerId } = await this.findOrFail(auth, personGroupId);
    const { name, birthDate, isHidden, featureFaceAssetId: assetId, isFavorite, color } = dto;
    // TODO: set by faceId directly
    let faceId: string | undefined;
    if (assetId) {
      await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [assetId] });
      const face = await this.personRepository.getForFeatureFaceUpdate({ personGroupId, assetId });
      if (!face) {
        throw new BadRequestException('Invalid assetId for feature face or asset is offline');
      }

      // A Locked photo is never a featured face (FL-53). The caller's own is refused plainly; anyone
      // else's gets the generic answer, so it never reveals that another person's photo is Locked.
      if (isLockedAssetRow({ visibility: face.visibility })) {
        if (face.ownerId === auth.user.id) {
          throw new BadRequestException('A Locked photo cannot be a featured photo');
        }
        throw new BadRequestException('Invalid assetId for feature face or asset is offline');
      }

      faceId = face.id;
    }

    const person = await this.personRepository.update({
      ownerId,
      personGroupId,
      faceAssetId: faceId,
      name,
      birthDate,
      isHidden,
      isFavorite,
      color,
    });

    if (assetId) {
      await this.jobRepository.queue({ name: JobName.PersonGenerateThumbnail, data: { ownerId, personGroupId } });
    }

    return mapPerson(person);
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
    await this.requirePerson(auth, Permission.PersonDelete, id);
    await this.removeAllPersonGroups([id], auth.user.id);
  }

  async updateAll(auth: AuthDto, dto: PeopleUpdateDto): Promise<BulkIdResponseDto[]> {
    const results: BulkIdResponseDto[] = [];
    for (const person of dto.people) {
      try {
        await this.update(auth, person.id, {
          isHidden: person.isHidden,
          name: person.name,
          birthDate: person.birthDate,
          featureFaceAssetId: person.featureFaceAssetId,
          isFavorite: person.isFavorite,
        });
        results.push({ id: person.id, success: true });
      } catch (error: any) {
        this.logger.error(`Unable to update ${person.id} : ${error}`, error?.stack);
        results.push({ id: person.id, success: false, error: BulkIdErrorReason.UNKNOWN });
      }
    }
    return results;
  }

  async deleteAll(auth: AuthDto, { ids }: BulkIdsDto): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.PersonDelete, ids });
    await this.removeAllPersonGroups(ids, auth.user.id);
  }

  @Chunked()
  private async removeAllPersonGroups(groupIds: string[], ownerId?: string) {
    if (groupIds.length === 0) {
      return;
    }

    const people = await this.personRepository.delete(groupIds, ownerId);
    await Promise.all(people.map((person) => this.storageRepository.unlink(person.thumbnailPath)));
    await this.personRepository.deleteEmptyGroups();
    // deleting, merging away and cleaning up people all come through here (FL-57)
    await this.purgeMergeVerdicts(ownerId);
    this.logger.debug(`Deleted ${groupIds.length} people`);
  }

  @OnJob({ name: JobName.PersonCleanup, queue: QueueName.BackgroundTask })
  async handlePersonCleanup(): Promise<JobStatus> {
    // each step can leave the next one something to clean up, so the order matters
    const people = await this.personRepository.getAllWithoutFaces();
    await this.removeAllPersonGroups(people.map((person) => person.personGroupId));

    const personGroups = await this.personRepository.deleteEmptyGroups();
    const clusterGroups = await this.personRepository.deleteOrphanedClusterGroups();

    this.logger.debug(`Deleted ${personGroups} empty person groups and ${clusterGroups} orphaned cluster groups`);

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetDetectFacesQueueAll, queue: QueueName.FaceDetection })
  async handleQueueDetectFaces({ force }: JobOf<JobName.AssetDetectFacesQueueAll>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isFacialRecognitionEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    if (force) {
      await this.personRepository.deleteFaces({ sourceType: SourceType.MachineLearning });
      await this.handlePersonCleanup();
      await this.personRepository.vacuum({ reindexVectors: true });
    }

    for await (const assets of batched(this.assetJobRepository.streamForDetectFacesJob(force))) {
      await this.jobRepository.queueAll(
        assets.map((asset) => ({ name: JobName.AssetDetectFaces, data: { id: asset.id } })),
      );
    }

    if (force === undefined) {
      await this.jobRepository.queue({ name: JobName.PersonCleanup });
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetDetectFaces, queue: QueueName.FaceDetection })
  async handleDetectFaces({ id }: JobOf<JobName.AssetDetectFaces>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!isFacialRecognitionEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    const asset = await this.assetJobRepository.getForDetectFacesJob(id);
    const previewFile = asset?.files.find((file) => file.isEdited) ?? asset?.files[0];
    if (!asset || !previewFile) {
      return JobStatus.Failed;
    }

    if (asset.visibility === AssetVisibility.Hidden) {
      return JobStatus.Skipped;
    }

    const selection = await this.selectRoutedMlDestination({
      workload: MlWorkload.Face,
      jobId: id,
      jobName: JobName.AssetDetectFaces,
    });
    const { imageHeight, imageWidth, faces } = await this.machineLearningRepository.detectFaces(
      selection,
      previewFile.path,
      machineLearning.facialRecognition,
    );
    this.logger.debug(`${faces.length} faces detected in ${previewFile.path}`);

    const facesToAdd: (Insertable<AssetFaceTable> & { id: string })[] = [];
    const embeddings: FaceSearchTable[] = [];
    const mlFaceIds = new Set<string>();

    for (const face of asset.faces) {
      if (face.sourceType === SourceType.MachineLearning) {
        mlFaceIds.add(face.id);
      }
    }

    const heightScale = imageHeight / (asset.faces[0]?.imageHeight || 1);
    const widthScale = imageWidth / (asset.faces[0]?.imageWidth || 1);
    for (const { boundingBox, embedding } of faces) {
      const scaledBox = {
        x1: boundingBox.x1 * widthScale,
        y1: boundingBox.y1 * heightScale,
        x2: boundingBox.x2 * widthScale,
        y2: boundingBox.y2 * heightScale,
      };
      const match = asset.faces.find((face) => this.iou(face, scaledBox) > 0.5);

      if (match && !mlFaceIds.delete(match.id)) {
        embeddings.push({ faceId: match.id, embedding });
      } else if (!match) {
        const faceId = this.cryptoRepository.randomUUID();
        facesToAdd.push({
          id: faceId,
          assetId: asset.id,
          imageHeight,
          imageWidth,
          boundingBoxX1: boundingBox.x1,
          boundingBoxY1: boundingBox.y1,
          boundingBoxX2: boundingBox.x2,
          boundingBoxY2: boundingBox.y2,
        });
        embeddings.push({ faceId, embedding });
      }
    }
    const faceIdsToRemove = [...mlFaceIds];

    if (facesToAdd.length > 0 || faceIdsToRemove.length > 0 || embeddings.length > 0) {
      await this.personRepository.refreshFaces(facesToAdd, faceIdsToRemove, embeddings);
    }

    if (faceIdsToRemove.length > 0) {
      this.logger.log(`Removed ${faceIdsToRemove.length} faces below detection threshold in asset ${id}`);
    }

    if (facesToAdd.length > 0) {
      this.logger.log(`Detected ${facesToAdd.length} new faces in asset ${id}`);
      const jobs = facesToAdd.map((face) => ({ name: JobName.FacialRecognition, data: { id: face.id } }) as const);
      await this.jobRepository.queueAll([{ name: JobName.FacialRecognitionQueueAll, data: { force: false } }, ...jobs]);
    } else if (embeddings.length > 0) {
      this.logger.log(`Added ${embeddings.length} face embeddings for asset ${id}`);
    }

    await this.assetRepository.upsertJobStatus({ assetId: asset.id, facesRecognizedAt: new Date() });

    return JobStatus.Success;
  }

  private iou(
    face: { boundingBoxX1: number; boundingBoxY1: number; boundingBoxX2: number; boundingBoxY2: number },
    newBox: BoundingBox,
  ): number {
    const x1 = Math.max(face.boundingBoxX1, newBox.x1);
    const y1 = Math.max(face.boundingBoxY1, newBox.y1);
    const x2 = Math.min(face.boundingBoxX2, newBox.x2);
    const y2 = Math.min(face.boundingBoxY2, newBox.y2);

    const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const area1 = (face.boundingBoxX2 - face.boundingBoxX1) * (face.boundingBoxY2 - face.boundingBoxY1);
    const area2 = (newBox.x2 - newBox.x1) * (newBox.y2 - newBox.y1);
    const union = area1 + area2 - intersection;

    return intersection / union;
  }

  @OnJob({ name: JobName.FacialRecognitionQueueAll, queue: QueueName.FacialRecognition })
  async handleQueueRecognizeFaces({
    force,
    nightly,
    clusterGroupId,
  }: JobOf<JobName.FacialRecognitionQueueAll>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isFacialRecognitionEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    await this.jobRepository.waitForQueueCompletion(QueueName.ThumbnailGeneration, QueueName.FaceDetection);

    if (nightly) {
      const [state, latestFaceDate] = await Promise.all([
        this.systemMetadataRepository.get(SystemMetadataKey.FacialRecognitionState),
        this.personRepository.getLatestFaceDate(),
      ]);

      if (state?.lastRun && latestFaceDate && state.lastRun > latestFaceDate) {
        this.logger.debug('Skipping facial recognition nightly since no face has been added since the last run');
        return JobStatus.Skipped;
      }
    }

    const { waiting } = await this.jobRepository.getJobCounts(QueueName.FacialRecognition);

    if (force) {
      await this.personRepository.unassignFaces({ clusterGroupId, sourceType: SourceType.MachineLearning });
      await this.handlePersonCleanup();
      await this.personRepository.vacuum({ reindexVectors: false });
    } else if (waiting) {
      this.logger.debug(
        `Skipping facial recognition queueing because ${waiting} job${waiting > 1 ? 's are' : ' is'} already queued`,
      );
      return JobStatus.Skipped;
    }

    await this.databaseRepository.prewarm(VectorIndex.Face);

    const lastRun = new Date().toISOString();

    const faces = this.personRepository.getAllFaces(
      force
        ? { clusterGroupId, sourceType: clusterGroupId ? SourceType.MachineLearning : undefined }
        : { personGroupId: null, clusterGroupId, sourceType: SourceType.MachineLearning },
    );
    for await (const batch of batched(faces)) {
      await this.jobRepository.queueAll(
        batch.map((face) => ({ name: JobName.FacialRecognition, data: { id: face.id, deferred: false } })),
      );
    }

    await this.systemMetadataRepository.set(SystemMetadataKey.FacialRecognitionState, { lastRun });

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.FacialRecognition, queue: QueueName.FacialRecognition })
  async handleRecognizeFaces({ id, deferred }: JobOf<JobName.FacialRecognition>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!isFacialRecognitionEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    const face = await this.personRepository.getFaceForFacialRecognitionJob(id);
    if (!face || !face.asset) {
      this.logger.warn(`Face ${id} not found`);
      return JobStatus.Failed;
    }

    if (face.sourceType !== SourceType.MachineLearning) {
      this.logger.warn(`Skipping face ${id} due to source ${face.sourceType}`);
      return JobStatus.Skipped;
    }

    if (!face.faceSearch?.embedding) {
      this.logger.warn(`Face ${id} does not have an embedding`);
      return JobStatus.Failed;
    }

    if (face.personGroupId) {
      this.logger.debug(`Face ${id} already has a person assigned`);
      return JobStatus.Skipped;
    }

    // FL-38: a face its owner corrected (for example unassigned on purpose) keeps that answer
    if (face.correctedAt) {
      this.logger.debug(`Face ${id} was corrected by its owner, skipping`);
      return JobStatus.Skipped;
    }

    const { ownerId, clusterGroupId } = face.asset;
    const matches = await this.searchRepository.searchFaces({
      clusterGroupId,
      embedding: face.faceSearch.embedding,
      maxDistance: machineLearning.facialRecognition.maxDistance,
      numResults: machineLearning.facialRecognition.minFaces,
      minBirthDate: new Date(face.asset.fileCreatedAt),
    });

    // `matches` also includes the face itself
    if (machineLearning.facialRecognition.minFaces > 1 && matches.length <= 1) {
      this.logger.debug(`Face ${id} only matched the face itself, skipping`);
      return JobStatus.Skipped;
    }

    this.logger.debug(`Face ${id} has ${matches.length} matches`);

    const isCore =
      matches.length >= machineLearning.facialRecognition.minFaces &&
      face.asset.visibility === AssetVisibility.Timeline;
    if (!isCore && !deferred) {
      this.logger.debug(`Deferring non-core face ${id} for later processing`);
      await this.jobRepository.queue({ name: JobName.FacialRecognition, data: { id, deferred: true } });
      return JobStatus.Skipped;
    }

    let personGroupId = matches.find((match) => match.personGroupId)?.personGroupId;
    if (!personGroupId) {
      const [matchWithPerson] = await this.searchRepository.searchFaces({
        clusterGroupId,
        embedding: face.faceSearch.embedding,
        maxDistance: machineLearning.facialRecognition.maxDistance,
        numResults: 1,
        hasPerson: true,
        minBirthDate: new Date(face.asset.fileCreatedAt),
      });

      personGroupId = matchWithPerson?.personGroupId ?? undefined;
    }

    if (!personGroupId && isCore) {
      const group = await this.personRepository.createGroup(ownerId);
      personGroupId = group.id;
      this.logger.log(`Created person group ${personGroupId} for face ${id}`);
    }

    if (personGroupId) {
      // A face on a Locked photo is never a person's thumbnail (FL-53): such a person takes another
      // face of theirs once this one is assigned, or none.
      const isLocked = isLockedAssetRow(face.asset);
      const person = await this.personRepository.getByGroupId({ ownerId, personGroupId });
      if (person) {
        this.logger.debug(`Face ${id} matched person ${person.personGroupId}`);
      } else {
        await this.personRepository.create({ ownerId, faceAssetId: isLocked ? null : face.id, personGroupId });
        this.logger.log(`Created person for face ${id} in group ${personGroupId}`);
        if (!isLocked) {
          await this.jobRepository.queue({
            name: JobName.PersonGenerateThumbnail,
            data: { ownerId, personGroupId },
          });
        }
      }

      this.logger.debug(`Assigning face ${id} to person group ${personGroupId}`);
      await this.personRepository.reassignFaces({ faceIds: [id], newPersonGroupId: personGroupId });

      if (!person && isLocked) {
        await this.createNewFeaturePhoto([{ ownerId, personGroupId }]);
      }
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.PersonFileMigration, queue: QueueName.Migration })
  async handlePersonMigration({ ownerId, personGroupId }: JobOf<JobName.PersonFileMigration>): Promise<JobStatus> {
    const person = await this.personRepository.getByGroupId({ ownerId, personGroupId });
    if (!person) {
      return JobStatus.Failed;
    }

    await this.storageCore.movePersonFile(person, PersonPathType.Face);

    return JobStatus.Success;
  }

  async mergePerson(auth: AuthDto, personGroupId: string, dto: MergePersonDto): Promise<BulkIdResponseDto[]> {
    // The route names the person the others merge into; that person answers like any other single read
    await this.requirePerson(auth, Permission.PersonMerge, personGroupId);
    return this.mergePeople(auth, { ids: [personGroupId, ...dto.ids] });
  }

  async mergePeople(auth: AuthDto, { ids }: MergePersonDto): Promise<BulkIdResponseDto[]> {
    if (ids.length < 2) {
      throw new BadRequestException('At least two people are required for merging');
    }

    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('Cannot merge a person into themselves');
    }

    const results: BulkIdResponseDto[] = [];

    const allowedIds = await this.checkAccess({ auth, permission: Permission.PersonMerge, ids });

    const peopleMap: Record<string, Selectable<PersonTable>[]> = {};

    for (const mergePerson of await this.personRepository.getForMergePerson(ids)) {
      if (!peopleMap[mergePerson.personGroupId]) {
        peopleMap[mergePerson.personGroupId] = [];
      }
      peopleMap[mergePerson.personGroupId].push(mergePerson);
    }

    const targetPeople: Record<string, Selectable<PersonTable>> = {};
    for (const mergeId of ids) {
      const hasAccess = allowedIds.has(mergeId);
      if (!hasAccess) {
        results.push({ id: mergeId, success: false, error: BulkIdErrorReason.NO_PERMISSION });
        continue;
      }

      for (const mergePerson of peopleMap[mergeId]) {
        if (!targetPeople[mergePerson.ownerId]) {
          targetPeople[mergePerson.ownerId] = mergePerson;
          continue;
        }

        const targetPerson = targetPeople[mergePerson.ownerId];

        if (
          mergePerson.ownerId !== auth.user.id &&
          ((targetPerson.name && mergePerson.name) || (targetPerson.birthDate && mergePerson.birthDate))
        ) {
          continue;
        }

        const changes: Updateable<Person> = omitBy(
          {
            name: mergePerson.name && !targetPerson.name ? mergePerson.name : undefined,
            birthDate: mergePerson.birthDate && !targetPerson.birthDate ? mergePerson.birthDate : undefined,
          },
          isUndefined,
        );

        if (Object.keys(changes).length > 0) {
          targetPeople[mergePerson.ownerId] = await this.personRepository.update({
            ownerId: targetPerson.ownerId,
            personGroupId: targetPerson.personGroupId,
            ...changes,
          });
        }

        const mergeName = mergePerson.name || mergePerson.personGroupId;
        const mergeData: UpdateFacesData = {
          oldPersonGroupId: mergeId,
          newPersonGroupId: targetPerson.personGroupId,
          ownerId: targetPerson.ownerId,
        };
        this.logger.log(`Merging ${mergeName} into ${targetPerson.name || targetPerson.personGroupId}`);

        try {
          await this.personRepository.reassignFaces(mergeData);
          await this.removeAllPersonGroups([mergeId], targetPerson.ownerId);

          this.logger.log(`Merged ${mergeName} into ${targetPerson.name || targetPerson.personGroupId}`);
          results.push({ id: mergeId, success: true });
        } catch (error: any) {
          this.logger.error(`Unable to merge ${mergeId} into ${targetPerson.personGroupId}: ${error}`, error?.stack);
          results.push({ id: mergeId, success: false, error: BulkIdErrorReason.UNKNOWN });
        }
      }
    }

    return results;
  }

  private async findOrFail(auth: AuthDto, personGroupId: string) {
    // A 404 like the access check's, so a person removed between the two reads looks missing too
    const person = await this.personRepository.getByGroupId({ ownerId: auth.user.id, personGroupId });
    if (!person) {
      throw new NotFoundException('Person not found');
    }
    return person;
  }

  /**
   * The access check for a route that names one person (FL-37). A missing person, someone else's,
   * and one suppressed while the session is not unlocked (owner decision, September 22, 2026) all
   * answer the same 404; the access query itself leaves the suppressed person out.
   */
  private requirePerson(auth: AuthDto, permission: Permission, personGroupId: string) {
    return requireEntityAccess(this.accessRepository, { auth, permission, ids: [personGroupId] }, 'Person');
  }

  async createFace(auth: AuthDto, dto: AssetFaceCreateDto): Promise<AssetFaceResponseDto> {
    await Promise.all([
      this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: [dto.assetId] }),
      this.requirePerson(auth, Permission.PersonRead, dto.personId),
    ]);

    const [asset, person] = await Promise.all([
      this.assetRepository.getById(dto.assetId, { edits: true, exifInfo: true }),
      this.findOrFail(auth, dto.personId),
    ]);

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    // FL-38: a box drawn on an image that has since changed would land in the wrong place
    this.requireFaceSource(asset, dto.expectedSourceRevision);

    const id = this.cryptoRepository.randomUUID();
    await this.personRepository.createAssetFace({
      id,
      personGroupId: person.personGroupId,
      assetId: dto.assetId,
      ...this.toStoredFaceBox(asset, dto),
      sourceType: SourceType.Manual,
    });

    if (!person.faceAssetId) {
      await this.createNewFeaturePhoto([person]);
    }

    return this.mapStoredFace(auth, id);
  }

  /** FL-38: the revision a face tagger draws against (see `getFaceSourceRevision`). */
  async getFaceSource(auth: AuthDto, dto: FaceDto): Promise<AssetFaceSourceResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: [dto.id] });
    const asset = await this.assetRepository.getById(dto.id, { edits: true, exifInfo: true });
    if (!asset) {
      throw new NotFoundException('Asset not found');
    }
    return { assetId: dto.id, revision: getFaceSourceRevision(asset) };
  }

  /**
   * FL-38: one revision-checked correction of an existing face, detected or manual: reassign
   * or unassign it, move or resize it, hide it or show it again. The correction applies only
   * while the face is still at `expectedRevision` (and, when given, still assigned to
   * `expectedPersonId`), so it never overwrites a change another editor made meanwhile (409).
   */
  async correctFace(auth: AuthDto, id: string, dto: AssetFaceCorrectionDto): Promise<AssetFaceResponseDto> {
    await this.requireAccess({ auth, permission: Permission.FaceUpdate, ids: [id] });
    if (dto.personId) {
      await this.requirePerson(auth, Permission.PersonUpdate, dto.personId);
    }

    const face = await this.personRepository.getFaceForCorrection(id, { viewingUserId: auth.user.id });
    if (!face) {
      throw new NotFoundException('Face not found');
    }
    const staleFace = () => new ConflictException('This face changed in another view. Reload it before correcting it.');
    if (face.updateId !== dto.expectedRevision) {
      throw staleFace();
    }
    if (dto.expectedPersonId !== undefined && face.personGroupId !== dto.expectedPersonId) {
      throw staleFace();
    }

    const target = dto.personId ? await this.findOrFail(auth, dto.personId) : null;
    let box: FaceBoxPixels | undefined;
    if (dto.box) {
      const asset = await this.assetRepository.getById(face.assetId, { edits: true, exifInfo: true });
      if (!asset) {
        throw new NotFoundException('Asset not found');
      }
      this.requireFaceSource(asset, dto.expectedSourceRevision);
      box = this.toStoredFaceBox(asset, dto.box);
    }

    const changed = await this.personRepository.correctFace(id, dto.expectedRevision, {
      personGroupId: dto.personId === undefined ? undefined : (target?.personGroupId ?? null),
      box,
      hidden: dto.hidden,
    });
    if (changed === 0) {
      throw staleFace();
    }

    const previous = face.person;
    const leavesPrevious = (dto.personId !== undefined && dto.personId !== face.personGroupId) || dto.hidden === true;
    const featureChanges = new Map<string, PersonId>();
    if (target && target.faceAssetId === null) {
      featureChanges.set(personKey(target), target);
    }
    if (previous && previous.faceAssetId === face.id && leavesPrevious) {
      featureChanges.set(personKey(previous), previous);
    }
    if (featureChanges.size > 0) {
      await this.createNewFeaturePhoto(featureChanges.values().toArray());
    }
    if (box && previous && previous.faceAssetId === face.id && !leavesPrevious) {
      // the featured face moved: redraw the person's photo from the new box
      await this.jobRepository.queue({
        name: JobName.PersonGenerateThumbnail,
        data: { ownerId: previous.ownerId, personGroupId: previous.personGroupId },
      });
    }

    return this.mapStoredFace(auth, id);
  }

  async deleteFace(auth: AuthDto, id: string, dto: AssetFaceDeleteDto): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.FaceDelete, ids: [id] });

    if (dto.expectedRevision !== undefined) {
      // FL-38: refuse to remove a face someone changed since this client read it
      const changed = await this.personRepository.deleteFaceAtRevision(id, dto.expectedRevision, { force: dto.force });
      if (changed === 0) {
        throw new ConflictException('This face changed in another view. Reload it before removing it.');
      }
      return;
    }

    return dto.force ? this.personRepository.deleteAssetFace(id) : this.personRepository.softDeleteAssetFaces(id);
  }

  private requireFaceSource(asset: FaceSource, expectedSourceRevision?: string) {
    if (expectedSourceRevision !== undefined && expectedSourceRevision !== getFaceSourceRevision(asset)) {
      throw new ConflictException('The image changed since this face was drawn. Reload it before placing faces.');
    }
  }

  /**
   * A box drawn on the displayed preview, in the pixels it is stored in. The client draws on the
   * upright, edited preview; with edits the box is converted back to the original, unedited
   * image, otherwise the preview's size is kept as the face's image size.
   */
  private toStoredFaceBox(
    asset: NonNullable<Awaited<ReturnType<typeof this.assetRepository.getById>>>,
    dto: Pick<AssetFaceBoxDto, 'imageWidth' | 'imageHeight' | 'x' | 'y' | 'width' | 'height'>,
  ): FaceBoxPixels {
    const edits = asset.edits || [];
    let imageWidth = dto.imageWidth;
    let imageHeight = dto.imageHeight;
    let topLeft: Point = { x: dto.x, y: dto.y };
    let bottomRight: Point = { x: dto.x + dto.width, y: dto.y + dto.height };

    // the coordinates received from the client are based on the edited preview image
    // we need to convert them to the coordinate space of the original unedited image
    if (edits.length > 0) {
      if (!asset.width || !asset.height || !asset.exifInfo?.exifImageWidth || !asset.exifInfo?.exifImageHeight) {
        throw new BadRequestException('Asset does not have valid dimensions');
      }

      // convert from preview to full dimensions
      const scaleFactor = asset.width / dto.imageWidth;
      topLeft = { x: topLeft.x * scaleFactor, y: topLeft.y * scaleFactor };
      bottomRight = { x: bottomRight.x * scaleFactor, y: bottomRight.y * scaleFactor };

      const [invertedTopLeft, invertedBottomRight] = transformPoints(
        [topLeft, bottomRight],
        edits,
        { width: asset.width, height: asset.height },
        { inverse: true },
      ).points;

      // make sure topLeft is top-left and bottomRight is bottom-right
      topLeft = {
        x: Math.min(invertedTopLeft.x, invertedBottomRight.x),
        y: Math.min(invertedTopLeft.y, invertedBottomRight.y),
      };
      bottomRight = {
        x: Math.max(invertedTopLeft.x, invertedBottomRight.x),
        y: Math.max(invertedTopLeft.y, invertedBottomRight.y),
      };

      // now coordinates are in original image space
      const originalDimensions = getDimensions(asset.exifInfo);
      imageWidth = originalDimensions.width;
      imageHeight = originalDimensions.height;
    }

    return {
      imageWidth,
      imageHeight,
      boundingBoxX1: Math.round(topLeft.x),
      boundingBoxX2: Math.round(bottomRight.x),
      boundingBoxY1: Math.round(topLeft.y),
      boundingBoxY2: Math.round(bottomRight.y),
    };
  }

  /** A stored face (hidden or not) as the client sees it, in the displayed image's space. */
  private async mapStoredFace(auth: AuthDto, id: string): Promise<AssetFaceResponseDto> {
    const face = await this.personRepository.getFaceForCorrection(id, { viewingUserId: auth.user.id });
    if (!face) {
      throw new NotFoundException('Face not found');
    }
    const asset = await this.assetRepository.getForFaces(face.assetId);
    return mapFaces(face, auth, asset.edits, getDimensions(asset));
  }
}
