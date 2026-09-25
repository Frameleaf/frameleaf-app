import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { isUndefined, omitBy } from 'lodash-es';
import type { Insertable, Selectable, Updateable } from 'kysely';
import type { Person } from 'src/database.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { BoundingBox } from 'src/repositories/machine-learning.repository.js';
import type {
  FaceBoxPixels,
  FaceCorrection,
  FaceCorrectionAction,
  FaceCorrectionInput,
  PersonId,
  UpdateFacesData,
} from 'src/repositories/person.repository.js';
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
  FaceEvidenceDto,
  FaceSearchDto,
  MergePersonDto,
  MergeSuggestionsResponseDto,
  PeopleResponseDto,
  PeopleUpdateDto,
  PersonCorrectionDto,
  PersonCorrectionSearchDto,
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
import {
  FaceBoundingBoxRow,
  NormalizedBox,
  anchorBox,
  fractionBox,
  matchAnchoredFaces,
  sameChecksum,
} from 'src/utils/face-anchor.js';
import { type FaceSource, getFaceSourceRevision } from 'src/utils/face-source.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import { getHiddenContentQueryOptions, isSuppressedWhileLocked } from 'src/utils/hidden-content.js';
import { isLockedAssetRow } from 'src/utils/locked-visibility.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { batched, isFacialRecognitionEnabled } from 'src/utils/misc.js';
import { Point, transformFaceBoundingBox, transformPoints } from 'src/utils/transform.js';

const personKey = ({ ownerId, personGroupId }: PersonId) => `${ownerId}/${personGroupId}`;

const staleFaceRemoval = () =>
  new ConflictException('This face changed in another view. Reload it before removing it.');

/** FL-57: the decisions an owner can undo from their correction history. */
const UNDOABLE_CORRECTIONS = new Set<FaceCorrectionAction>(['reassign', 'new-person', 'unassign', 'remove']);

type CorrectionConflictReason =
  'already-undone' | 'not-undoable' | 'source-changed' | 'face-gone' | 'face-changed' | 'person-gone';

/** A 409 whose body names why a correction could not be undone (FL-57). */
const correctionConflict = (reason: CorrectionConflictReason, message: string) =>
  new ConflictException({ statusCode: 409, error: 'Conflict', message, reason });

const isDefinedId = (id: string | null): id is string => !!id;

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
   * may be the same person so the People page can offer same/different/later/ignore instead of
   * requiring the user to notice a duplicate on their own. Reuses the facial-recognition job's own
   * similarity metric (`machineLearning.facialRecognition.maxDistance`) rather than a second,
   * invented threshold, so a suggestion here is calibrated the same way automatic clustering is.
   *
   * Each suggestion carries evidence for both people: a reference face and the complete photo it is
   * in, only ever from media the viewer may be shown (their own, not trashed, not Locked, not hidden
   * by their suppression rules), or null when there is none.
   *
   * Answers are recorded with `setMergeVerdict`; `deleteMergeVerdict` is the undo.
   */
  async getMergeSuggestions(auth: AuthDto): Promise<MergeSuggestionsResponseDto> {
    // answers about people recognition has since rebuilt follow them first (see `reanchorMergeVerdicts`)
    await this.reanchorMergeVerdicts(auth.user.id);
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
    const byId = new Map(
      people.filter((person) => person.ownerId === auth.user.id).map((person) => [person.personGroupId, person]),
    );
    const references = await this.personRepository.getReferenceFaces(
      auth.user.id,
      ids,
      getHiddenContentQueryOptions(auth),
    );
    const evidence = new Map<string, FaceEvidenceDto>();
    for (const reference of references) {
      evidence.set(reference.personGroupId, {
        assetId: reference.assetId,
        faceId: reference.faceId,
        box: await this.displayedFaceBox(reference.assetId, reference),
      });
    }

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
          personEvidence: evidence.get(candidate.personId) ?? null,
          suggestionEvidence: evidence.get(candidate.suggestionId) ?? null,
        });
      }
    }

    return { suggestions };
  }

  /**
   * FL-57: answers a suggested pair of the user's people.
   * - `same` merges them now (the named person survives, or `personId` when both or neither are
   *   named) and records the merge in both people's correction history;
   * - `different` never suggests the pair again, `later` not for 30 days;
   * - `ignore` stops suggesting `personId` with anyone (stored as that person paired with itself).
   * A stale "later" never replaces a stored "different".
   */
  async setMergeVerdict(auth: AuthDto, dto: PersonMergeVerdictCreateDto): Promise<PersonMergeVerdictResponseDto> {
    const [personId, suggestionId] = await this.requireMergePair(auth, dto);
    if (dto.verdict === 'same') {
      return this.acceptMergeSuggestion(auth, dto.personId.toLowerCase(), dto.suggestionId.toLowerCase());
    }

    const [first, second] =
      dto.verdict === 'ignore' ? [dto.personId.toLowerCase(), dto.personId.toLowerCase()] : [personId, suggestionId];
    const { verdict, createdAt } = await this.personRepository.setMergeVerdict(
      auth.user.id,
      first,
      second,
      dto.verdict,
    );
    return { personId: first, suggestionId: second, verdict, createdAt: asDateTimeString(createdAt) };
  }

  /**
   * FL-57: undoes a recorded merge-suggestion verdict, so the pair can be suggested again. The same id
   * twice undoes "ignore" for that person.
   */
  async deleteMergeVerdict(auth: AuthDto, dto: PersonMergeVerdictDeleteDto): Promise<void> {
    const [personId, suggestionId] =
      dto.personId.toLowerCase() === dto.suggestionId.toLowerCase()
        ? await this.requireIgnoredPerson(auth, dto.personId)
        : await this.requireMergePair(auth, dto);
    const deleted = await this.personRepository.deleteMergeVerdict(auth.user.id, personId, suggestionId);
    if (!deleted) {
      throw new NotFoundException('Merge suggestion verdict not found');
    }
  }

  private async acceptMergeSuggestion(
    auth: AuthDto,
    personId: string,
    suggestionId: string,
  ): Promise<PersonMergeVerdictResponseDto> {
    const [person, suggestion] = await Promise.all([
      this.findOrFail(auth, personId),
      this.findOrFail(auth, suggestionId),
    ]);
    const [survivor, merged] = person.name || !suggestion.name ? [person, suggestion] : [suggestion, person];
    const results = await this.mergePeople(auth, { ids: [survivor.personGroupId, merged.personGroupId] });
    const result = results.find(({ id }) => id === merged.personGroupId);
    if (!result?.success) {
      throw new BadRequestException('These people could not be merged');
    }
    return {
      personId: survivor.personGroupId,
      suggestionId: merged.personGroupId,
      verdict: 'same',
      createdAt: new Date().toISOString(),
    };
  }

  /** Both people of a pair must be the user's own (and visible to this session), stored in id order. */
  private async requireMergePair(auth: AuthDto, { personId, suggestionId }: PersonMergeVerdictDeleteDto) {
    if (personId.toLowerCase() === suggestionId.toLowerCase()) {
      throw new BadRequestException('A merge suggestion pairs two different people');
    }
    await this.requirePerson(auth, Permission.PersonRead, personId);
    await this.requirePerson(auth, Permission.PersonRead, suggestionId);
    // uuids compare bytewise in Postgres, which is the order of their lowercase hex form
    const [first, second] = [personId.toLowerCase(), suggestionId.toLowerCase()];
    return first < second ? [first, second] : [second, first];
  }

  private async requireIgnoredPerson(auth: AuthDto, personId: string) {
    await this.requirePerson(auth, Permission.PersonRead, personId);
    return [personId.toLowerCase(), personId.toLowerCase()];
  }

  /** A deleted account's merge-suggestion verdicts and face correction history go with it (FL-57). */
  @OnEvent({ name: 'UserDelete' })
  async onUserDelete({ id }: ArgOf<'UserDelete'>) {
    await this.duringForkWrites('remove the people history of a deleted account', () =>
      this.personRepository.deleteForkPeopleData(id),
    );
  }

  /**
   * Merge-suggestion answers follow their people (FL-57): an answer about a person merged away or
   * rebuilt by recognition moves to whoever holds its anchor face now, and is dropped once its people
   * are gone or merged together. Like the other fork-owned writes this waits out a database handoff:
   * it is skipped then and the next run catches up.
   */
  private async reanchorMergeVerdicts(ownerId?: string) {
    await this.duringForkWrites('update merge-suggestion answers', () =>
      this.personRepository.reanchorMergeVerdicts(ownerId),
    );
  }

  /** Runs a fork-owned write; during a database handoff it is skipped with a warning (FL-57). */
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

  /**
   * FL-57: records manual face decisions in the owner's correction history. Call it after the change,
   * so the entry anchors the face as it is now (its photo, the original's checksum and the box). During
   * a database handoff nothing is recorded and a warning is logged; the change itself stands.
   */
  async recordFaceCorrections(entries: FaceCorrectionInput[]): Promise<void> {
    await this.duringForkWrites('record face corrections', () => this.personRepository.recordFaceCorrections(entries));
  }

  /**
   * FL-57: generated descriptions and video captions that named these people, or were made of these
   * assets, may now name the wrong people. The refresh job works out which ones actually changed.
   */
  private async refreshIdentities(ownerId: string, change: { personGroupIds?: string[]; assetIds?: string[] }) {
    const personGroupIds = [...new Set(change.personGroupIds)];
    const assetIds = [...new Set(change.assetIds)];
    if (personGroupIds.length === 0 && assetIds.length === 0) {
      return;
    }
    await this.jobRepository.queue({
      name: JobName.PersonIdentityRefresh,
      data: {
        ownerId,
        ...(personGroupIds.length > 0 && { personGroupIds }),
        ...(assetIds.length > 0 && { assetIds }),
      },
    });
  }

  /** FL-57: the owner's correction history for a person, newest first, a page at a time. */
  async getCorrectionHistory(
    auth: AuthDto,
    personGroupId: string,
    { page, size }: PersonCorrectionSearchDto,
  ): Promise<PersonCorrectionsResponseDto> {
    await this.requirePerson(auth, Permission.PersonRead, personGroupId);
    const { items, hasNextPage } = await this.personRepository.getFaceCorrections(auth.user.id, personGroupId, {
      take: size,
      skip: (page - 1) * size,
    });
    return { corrections: await this.mapCorrections(auth, items), hasNextPage };
  }

  /**
   * FL-57: undoes one manual face decision. It is reversed only while the face still stands as the
   * decision left it: the same original (checksum), a face at the anchored place, and the person or
   * state the decision gave it. Otherwise 409 with a `reason`: `already-undone`, `not-undoable`,
   * `source-changed`, `face-gone`, `face-changed` or `person-gone`.
   */
  async undoCorrection(auth: AuthDto, id: string): Promise<PersonCorrectionDto> {
    const entry = await this.personRepository.getFaceCorrection(auth.user.id, id);
    if (!entry) {
      throw new NotFoundException('Correction not found');
    }
    if (entry.undoneAt) {
      throw correctionConflict('already-undone', 'This change was already undone');
    }
    if (!UNDOABLE_CORRECTIONS.has(entry.action) || !entry.assetId) {
      throw correctionConflict('not-undoable', 'This change cannot be undone');
    }

    const asset = await this.assetRepository.getById(entry.assetId);
    if (!asset || asset.deletedAt) {
      throw correctionConflict('face-gone', 'The photo of this face is no longer available');
    }
    if (!sameChecksum(entry.assetChecksum, asset.checksum)) {
      throw correctionConflict('source-changed', 'The original photo was replaced since this change');
    }

    const face = await this.findAnchoredFace(entry);
    if (!face) {
      throw correctionConflict('face-gone', 'This face is no longer detected');
    }
    await this.requireAccess({ auth, permission: Permission.PersonCreate, ids: [face.id] });

    const standing =
      entry.action === 'remove'
        ? face.deletedAt !== null
        : face.deletedAt === null && face.personGroupId === (entry.action === 'unassign' ? null : entry.toPersonId);
    if (!standing) {
      throw correctionConflict('face-changed', 'This face has changed since');
    }

    const restoreTo = entry.fromPersonId;
    if (entry.action !== 'remove' && restoreTo) {
      const previous = await this.personRepository.getByGroupId({ ownerId: auth.user.id, personGroupId: restoreTo });
      if (!previous) {
        throw correctionConflict('person-gone', 'The person this face belonged to no longer exists');
      }
    }

    // FL-38: the face is written only at the revision checked above, together with the history
    // entry, so an undo never overwrites a correction another view made meanwhile
    const outcome = await this.personRepository.undoFaceCorrection(
      entry.id,
      { id: face.id, expectedRevision: face.updateId },
      entry.action === 'remove' ? { restore: true } : { personGroupId: restoreTo },
    );
    if (outcome === 'already-undone') {
      throw correctionConflict('already-undone', 'This change was already undone');
    }
    if (outcome === 'face-changed') {
      throw correctionConflict('face-changed', 'This face has changed since');
    }

    await this.refreshFeaturePhotos(auth.user.id, [restoreTo, face.personGroupId], face.id);
    await this.refreshIdentities(asset.ownerId, { assetIds: [asset.id] });

    const [undone] = await this.mapCorrections(auth, [{ ...entry, faceId: face.id, undoneAt: new Date() }]);
    return undone;
  }

  /** The face a decision was about: the same row, or the face that replaced it at the anchored place. */
  private async findAnchoredFace(entry: FaceCorrection) {
    const faces = entry.assetId ? await this.personRepository.getAllFacesOfAsset(entry.assetId) : [];
    const same = faces.find(({ id }) => id === entry.faceId);
    if (same) {
      return same;
    }
    const [match] = matchAnchoredFaces([entry], faces);
    return match?.face;
  }

  /** People who lost their featured face to a change, or have none, get a new one. */
  private async refreshFeaturePhotos(ownerId: string, personGroupIds: (string | null)[], faceId: string) {
    const people: PersonId[] = [];
    for (const personGroupId of new Set(personGroupIds)) {
      if (!personGroupId) {
        continue;
      }
      const person = await this.personRepository.getByGroupId({ ownerId, personGroupId });
      if (person && (person.faceAssetId === null || person.faceAssetId === faceId)) {
        people.push(person);
      }
    }
    if (people.length > 0) {
      await this.createNewFeaturePhoto(people);
    }
  }

  private async mapCorrections(auth: AuthDto, entries: FaceCorrection[]): Promise<PersonCorrectionDto[]> {
    const personIds = [
      ...new Set(entries.flatMap(({ fromPersonId, toPersonId }) => [fromPersonId, toPersonId]).filter(isDefinedId)),
    ];
    const people = personIds.length > 0 ? await this.personRepository.getForMergePerson(personIds) : [];
    const names = new Map(
      people.filter(({ ownerId }) => ownerId === auth.user.id).map((person) => [person.personGroupId, person.name]),
    );
    const assetIds = [...new Set(entries.map(({ assetId }) => assetId).filter(isDefinedId))];
    const visible = await this.personRepository.getVisibleEvidenceAssetIds(
      auth.user.id,
      assetIds,
      getHiddenContentQueryOptions(auth),
    );

    const personRef = (id: string | null, snapshot: string | null) => {
      // a person suppressed while the session is not unlocked is not named (FL-37)
      if (!id || isSuppressedWhileLocked(auth, 'person', id)) {
        return null;
      }
      const current = names.get(id);
      return { id, name: current ?? snapshot ?? '', exists: current !== undefined };
    };

    const results: PersonCorrectionDto[] = [];
    for (const entry of entries) {
      const available = !!entry.assetId && visible.has(entry.assetId);
      const anchor = anchorBox(entry);
      results.push({
        id: entry.id,
        action: entry.action,
        createdAt: asDateTimeString(entry.createdAt) ?? '',
        undoneAt: asDateTimeString(entry.undoneAt) ?? null,
        fromPerson: personRef(entry.fromPersonId, entry.fromPersonName),
        toPerson: personRef(entry.toPersonId, entry.toPersonName),
        evidence:
          available && entry.assetId
            ? {
                assetId: entry.assetId,
                faceId: entry.faceId,
                box: anchor ? await this.displayedAnchorBox(entry.assetId, anchor) : null,
              }
            : null,
        evidenceRevoked: !!entry.assetId && !available,
        undoable: !entry.undoneAt && UNDOABLE_CORRECTIONS.has(entry.action),
      });
    }
    return results;
  }

  /** A face box as fractions of the photo as it is displayed, after its edits (as `mapFaces` does). */
  private async displayedFaceBox(assetId: string, face: FaceBoundingBoxRow): Promise<FaceEvidenceDto['box']> {
    try {
      const asset = await this.assetRepository.getForFaces(assetId);
      const box = transformFaceBoundingBox(
        {
          boundingBoxX1: face.boundingBoxX1,
          boundingBoxY1: face.boundingBoxY1,
          boundingBoxX2: face.boundingBoxX2,
          boundingBoxY2: face.boundingBoxY2,
          imageWidth: face.imageWidth,
          imageHeight: face.imageHeight,
        },
        asset.edits ?? [],
        getDimensions(asset),
      );
      return fractionBox(box);
    } catch {
      return fractionBox(face);
    }
  }

  /** A normalized anchor box (0..1 of the detection image) as it is displayed now. */
  private displayedAnchorBox(assetId: string, anchor: NormalizedBox): Promise<FaceEvidenceDto['box']> {
    const scale = 10_000;
    return this.displayedFaceBox(assetId, {
      boundingBoxX1: anchor.x1 * scale,
      boundingBoxY1: anchor.y1 * scale,
      boundingBoxX2: anchor.x2 * scale,
      boundingBoxY2: anchor.y2 * scale,
      imageWidth: scale,
      imageHeight: scale,
    });
  }

  async reassignFaces(auth: AuthDto, personGroupId: string, dto: AssetFaceUpdateDto): Promise<PersonResponseDto[]> {
    await this.requirePerson(auth, Permission.PersonUpdate, personGroupId);
    const person = await this.findOrFail(auth, personGroupId);
    const isNew = !(await this.personRepository.hasFaces(person.personGroupId));
    const result: PersonResponseDto[] = [];
    const changeFeaturePhoto = new Map<string, PersonId>();
    const corrections: FaceCorrectionInput[] = [];
    const assetIds: string[] = [];
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
        corrections.push({
          ownerId: auth.user.id,
          actorId: auth.user.id,
          action: isNew ? 'new-person' : 'reassign',
          faceId: face.id,
          fromPersonId: face.personGroupId,
          toPersonId: person.personGroupId,
          fromPersonName: face.person?.name ?? null,
          toPersonName: person.name,
        });
        assetIds.push(face.assetId);
      }

      result.push(mapPerson(person));
    }
    if (changeFeaturePhoto.size > 0) {
      await this.createNewFeaturePhoto(changeFeaturePhoto.values().toArray());
    }
    await this.recordFaceCorrections(corrections);
    await this.refreshIdentities(auth.user.id, { assetIds });
    return result;
  }

  async reassignFacesById(auth: AuthDto, personGroupId: string, dto: FaceDto): Promise<PersonResponseDto> {
    await this.requirePerson(auth, Permission.PersonUpdate, personGroupId);
    await this.requireAccess({ auth, permission: Permission.PersonCreate, ids: [dto.id] });
    const face = await this.personRepository.getFaceById(dto.id, { viewingUserId: auth.user.id });
    const person = await this.findOrFail(auth, personGroupId);
    const isNew = !(await this.personRepository.hasFaces(person.personGroupId));

    await this.personRepository.reassignFace(face.id, person.personGroupId);
    if (person.faceAssetId === null) {
      await this.createNewFeaturePhoto([person]);
    }
    if (face.person && face.person.faceAssetId === face.id) {
      await this.createNewFeaturePhoto([face.person]);
    }
    await this.recordFaceCorrections([
      {
        ownerId: auth.user.id,
        actorId: auth.user.id,
        action: isNew ? 'new-person' : 'reassign',
        faceId: face.id,
        fromPersonId: face.personGroupId,
        toPersonId: person.personGroupId,
        fromPersonName: face.person?.name ?? null,
        toPersonName: person.name,
      },
    ]);
    await this.refreshIdentities(auth.user.id, { assetIds: [face.assetId] });

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

    const current = await this.findOrFail(auth, personGroupId);
    const { ownerId } = current;
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

    // FL-57: a new name, or hiding or showing the person, changes the names generated text may use
    if ((name !== undefined && name !== current.name) || (isHidden !== undefined && isHidden !== current.isHidden)) {
      await this.refreshIdentities(ownerId, { personGroupIds: [personGroupId] });
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
    // deleting, merging away and cleaning up people all come through here: merge-suggestion answers
    // follow their anchor faces to whoever holds them now, or go (FL-57)
    await this.reanchorMergeVerdicts(ownerId);
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
    const decided = await this.getDecidedFaceIds(asset);

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

      // FL-57: a face kept for its explicit decision takes the new embedding too
      if (match && (!mlFaceIds.delete(match.id) || decided.has(match.id))) {
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
    // FL-57: a face with an explicit decision stays even when this detection no longer finds it
    const faceIdsToRemove = [...mlFaceIds.difference(decided)];

    if (facesToAdd.length > 0 || faceIdsToRemove.length > 0 || embeddings.length > 0) {
      await this.personRepository.refreshFaces(facesToAdd, faceIdsToRemove, embeddings);
    }

    const reapplied = facesToAdd.length > 0 ? await this.reapplyFaceDecisions(asset, facesToAdd) : new Set<string>();

    if (faceIdsToRemove.length > 0) {
      this.logger.log(`Removed ${faceIdsToRemove.length} faces below detection threshold in asset ${id}`);
    }

    if (facesToAdd.length > 0) {
      this.logger.log(`Detected ${facesToAdd.length} new faces in asset ${id}`);
      // a face that took over a person's decision is not left to recognition
      const jobs = facesToAdd
        .filter((face) => !reapplied.has(face.id))
        .map((face) => ({ name: JobName.FacialRecognition, data: { id: face.id } }) as const);
      await this.jobRepository.queueAll([{ name: JobName.FacialRecognitionQueueAll, data: { force: false } }, ...jobs]);
    } else if (embeddings.length > 0) {
      this.logger.log(`Added ${embeddings.length} face embeddings for asset ${id}`);
    }

    await this.assetRepository.upsertJobStatus({ assetId: asset.id, facesRecognizedAt: new Date() });

    return JobStatus.Success;
  }

  /**
   * FL-57: the faces of an asset carrying an explicit decision (moved by a person, or "not a face of
   * anyone") that still stands for this original. A decision anchored to a replaced original (another
   * checksum) no longer holds its face.
   */
  private async getDecidedFaceIds(asset: {
    checksum: Buffer | null;
    faces: { id: string; correctedAt: Date | string | null; deletedAt: Date | string | null }[];
  }): Promise<Set<string>> {
    const candidates = asset.faces.filter((face) => face.correctedAt !== null || face.deletedAt !== null);
    if (candidates.length === 0) {
      return new Set();
    }
    const anchored = await this.personRepository.getFaceDecisionChecksums(candidates.map(({ id }) => id));
    return new Set(
      candidates
        .filter((face) => !anchored.has(face.id) || sameChecksum(anchored.get(face.id) ?? null, asset.checksum))
        .map(({ id }) => id),
    );
  }

  /**
   * FL-57: when detection replaced a face row, the decisions recorded about the old face go to the new
   * face at the same place (overlapping box) on the same original (same checksum): its person, no
   * person, or "not a face of anyone". The history then points at the new face. Returns the new faces
   * that took a decision over.
   */
  private async reapplyFaceDecisions(
    asset: { id: string; checksum: Buffer | null },
    added: (Insertable<AssetFaceTable> & { id: string })[],
  ): Promise<Set<string>> {
    const entries = (await this.personRepository.getOrphanedFaceCorrections(asset.id)).filter((entry) =>
      sameChecksum(entry.assetChecksum, asset.checksum),
    );
    const reapplied = new Set<string>();
    if (entries.length === 0) {
      return reapplied;
    }

    const faces = added.map((face) => ({
      id: face.id,
      boundingBoxX1: face.boundingBoxX1 ?? 0,
      boundingBoxY1: face.boundingBoxY1 ?? 0,
      boundingBoxX2: face.boundingBoxX2 ?? 0,
      boundingBoxY2: face.boundingBoxY2 ?? 0,
      imageWidth: face.imageWidth ?? 0,
      imageHeight: face.imageHeight ?? 0,
    }));
    for (const { entry, face } of matchAnchoredFaces(entries, faces)) {
      if (entry.action === 'remove') {
        await this.personRepository.softDeleteAssetFaces(face.id);
      } else if (entry.action === 'unassign') {
        await this.personRepository.setFacePerson(face.id, null);
      } else if (
        entry.toPersonId &&
        (await this.personRepository.getByGroupId({ ownerId: entry.ownerId, personGroupId: entry.toPersonId }))
      ) {
        await this.personRepository.setFacePerson(face.id, entry.toPersonId);
      } else {
        continue;
      }
      await this.duringForkWrites('re-point face corrections', () =>
        this.personRepository.reanchorFaceCorrections(entry.faceId!, face.id),
      );
      reapplied.add(face.id);
      this.logger.debug(`Face ${face.id} took over the ${entry.action} decision about face ${entry.faceId}`);
    }
    return reapplied;
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

    // FL-38/FL-57: a face its owner corrected (for example unassigned on purpose) keeps that
    // answer; recognition never overrides an explicit decision
    if (face.correctedAt) {
      this.logger.debug(`Face ${id} carries an explicit decision, skipping`);
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
      // FL-57: only while the face is still undecided, so a correction made meanwhile stands
      const assigned = await this.personRepository.reassignFaces({
        faceIds: [id],
        newPersonGroupId: personGroupId,
        onlyUndecided: true,
      });
      if (assigned === 0) {
        this.logger.debug(`Face ${id} was decided meanwhile, keeping that decision`);
        return JobStatus.Skipped;
      }
      // FL-57: a named person now shows in this photo, so its generated text may name the wrong people
      if (person?.name) {
        await this.refreshIdentities(ownerId, { assetIds: [face.assetId] });
      }

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
          // FL-57: a merge is an explicit decision; a recognition rebuild keeps these faces together
          corrected: true,
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
          continue;
        }

        // FL-57: the merge is kept in the correction history, and generated text naming either person is
        // brought up to date; neither undoes the merge when it fails
        try {
          await this.recordFaceCorrections([
            {
              ownerId: targetPerson.ownerId,
              actorId: auth.user.id,
              action: 'merge',
              fromPersonId: mergeId,
              toPersonId: targetPerson.personGroupId,
              fromPersonName: mergePerson.name,
              toPersonName: targetPeople[mergePerson.ownerId].name,
            },
          ]);
          await this.refreshIdentities(targetPerson.ownerId, { personGroupIds: [targetPerson.personGroupId] });
        } catch (error: any) {
          this.logger.error(`Unable to record the merge of ${mergeId}: ${error}`, error?.stack);
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
    // FL-57: a new face of a named person can change what generated text should say
    await this.refreshIdentities(asset.ownerId, { assetIds: [asset.id] });

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
    const targetIsNew = target ? !(await this.personRepository.hasFaces(target.personGroupId)) : false;
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

    await this.recordFaceCorrections(this.faceCorrectionEntries(auth, face, dto, target, targetIsNew, !!box));
    await this.refreshIdentities(auth.user.id, { assetIds: [face.assetId] });

    return this.mapStoredFace(auth, id);
  }

  /**
   * FL-57: what a revision-checked correction (FL-38 `PATCH /faces/:id`) records in the correction
   * history: a move to someone (`new-person` when they had no faces yet), a take-off (`unassign`),
   * hiding the face ("not a face of anyone", `remove`) and a moved box (`box-move`).
   */
  private faceCorrectionEntries(
    auth: AuthDto,
    face: { id: string; personGroupId: string | null; person?: { name: string } | null },
    dto: AssetFaceCorrectionDto,
    target: { personGroupId: string; name: string } | null,
    targetIsNew: boolean,
    moved: boolean,
  ): FaceCorrectionInput[] {
    const base = {
      ownerId: auth.user.id,
      actorId: auth.user.id,
      faceId: face.id,
      fromPersonId: face.personGroupId,
      fromPersonName: face.person?.name ?? null,
    };
    const entries: FaceCorrectionInput[] = [];
    const reassigned = dto.personId !== undefined && (target?.personGroupId ?? null) !== face.personGroupId;
    if (reassigned) {
      entries.push(
        target
          ? {
              ...base,
              action: targetIsNew ? 'new-person' : 'reassign',
              toPersonId: target.personGroupId,
              toPersonName: target.name,
            }
          : { ...base, action: 'unassign' },
      );
    }
    if (dto.hidden === true) {
      entries.push({ ...base, action: 'remove' });
    }
    if (moved) {
      const personGroupId = reassigned ? (target?.personGroupId ?? null) : face.personGroupId;
      const name = reassigned ? (target?.name ?? null) : (face.person?.name ?? null);
      entries.push({
        ...base,
        action: 'box-move',
        fromPersonId: personGroupId,
        fromPersonName: name,
        toPersonId: personGroupId,
        toPersonName: name,
      });
    }
    return entries;
  }

  /**
   * Takes a face off (FL-57: "not a face of anyone"). The decision is recorded in the owner's history
   * either way: a soft delete can be undone, and both are applied again to a face detection finds at
   * the same place later. With `expectedRevision` (FL-38) it is refused when the face changed since.
   */
  async deleteFace(auth: AuthDto, id: string, dto: AssetFaceDeleteDto): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.FaceDelete, ids: [id] });
    const face = await this.personRepository.getFaceById(id, { viewingUserId: auth.user.id }).catch(() => {
      throw new NotFoundException('Face not found');
    });
    const correction: FaceCorrectionInput = {
      ownerId: auth.user.id,
      actorId: auth.user.id,
      action: 'remove',
      faceId: id,
      fromPersonId: face.personGroupId,
      fromPersonName: face.person?.name ?? null,
    };

    if (dto.force) {
      // recorded first: the face row is gone afterwards; a refused delete withdraws it again
      const [recorded] =
        (await this.duringForkWrites('record face corrections', () =>
          this.personRepository.recordFaceCorrections([correction]),
        )) ?? [];
      if (dto.expectedRevision === undefined) {
        await this.personRepository.deleteAssetFace(id);
      } else if ((await this.personRepository.deleteFaceAtRevision(id, dto.expectedRevision, { force: true })) === 0) {
        if (recorded) {
          await this.duringForkWrites('withdraw a face correction', () =>
            this.personRepository.deleteFaceCorrection(recorded.id),
          );
        }
        throw staleFaceRemoval();
      }
    } else {
      if (dto.expectedRevision === undefined) {
        await this.personRepository.softDeleteAssetFaces(id);
      } else if ((await this.personRepository.deleteFaceAtRevision(id, dto.expectedRevision, { force: false })) === 0) {
        // FL-38: refuse to remove a face someone changed since this client read it
        throw staleFaceRemoval();
      }
      await this.recordFaceCorrections([correction]);
    }
    await this.refreshFeaturePhotos(auth.user.id, [face.personGroupId], id);
    await this.refreshIdentities(auth.user.id, { assetIds: [face.assetId] });
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
