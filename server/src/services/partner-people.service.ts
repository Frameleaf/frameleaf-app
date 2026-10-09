import { ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { PersonCopyUndo } from 'src/repositories/partner-origin.repository.js';
import type { FaceCorrection, PartnerPersonLink } from 'src/repositories/person.repository.js';
import { JobName } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';

export type PartnerFaceCopyInput = {
  /** The asset the copy was made from (the partner's own, or their copy: A to B to C). */
  sourceAssetId: string;
  /** The recipient's new copy. */
  targetAssetId: string;
  targetOwnerId: string;
  /** The partner whose sharing produced the copy. */
  partnerSharedById: string;
};

/** What a person edit touched, as `PersonUpdateDto` carries it. */
export type PersonEdit = {
  name?: string;
  birthDate?: string | null;
  isHidden?: boolean;
  isFavorite?: boolean;
  color?: string | null;
  featureFaceAssetId?: string;
};

/**
 * Fields of a person copy that follow the partner's person until the recipient changes them. The cover
 * (featured face), favorite and color are always the recipient's own: their copy has other faces, and
 * favorites never follow (spec §4.2 default for assets, kept for people).
 */
const FOLLOWED_PERSON_FIELDS = ['name', 'birthDate', 'hidden'] as const;

const conflict = (reason: 'already-undone' | 'person-gone', message: string) =>
  new ConflictException({ statusCode: 409, error: 'Conflict', message, reason });

/**
 * Universal people for partner sharing (FL-326, spec §4.5).
 *
 * A partner copy brings the source's faces along with no ML re-run (the exact boxes and the
 * recognition embedding). Each of the partner's people is mapped once per recipient:
 *
 * 1. the mapping already made (`partner_person_link`, or a person copy's `person_origin`);
 * 2. the same person group, when both accounts share a recognition group and the recipient already has
 *    that person;
 * 3. one of the recipient's own people whose faces match above the recognition threshold
 *    (`machineLearning.facialRecognition.maxDistance`, as recognition itself uses): an auto-merge,
 *    recorded as a `partner-merge` entry in the recipient's correction history, which undoes it;
 * 4. otherwise a new person of the recipient's, copied from the partner's (name, birth date, hidden),
 *    with a `person_origin` so it follows the partner's later edits until the recipient changes them.
 */
@Injectable()
export class PartnerPeopleService extends BaseService {
  /** Copies the faces of `sourceAssetId` onto the recipient's copy. Returns how many were added. */
  async copyFaces(input: PartnerFaceCopyInput): Promise<number> {
    const faces = await this.personRepository.getFacesForPartnerCopy(input.sourceAssetId);
    if (faces.length === 0) {
      return 0;
    }

    // a copy always comes from the sharing partner's library (their own item, or their copy: A to B to C)
    const sourceOwnerId = input.partnerSharedById;
    const mapped = new Map<string, string>();
    const copies: Array<{ sourceFaceId: string; faceId: string; personGroupId: string | null }> = [];
    for (const face of faces) {
      let personGroupId: string | null = null;
      if (face.personGroupId) {
        personGroupId =
          mapped.get(face.personGroupId) ??
          (await this.resolvePerson({
            ...input,
            sourceOwnerId,
            sourcePersonGroupId: face.personGroupId,
            sampleFaceId: face.hasEmbedding ? face.id : undefined,
          }));
        mapped.set(face.personGroupId, personGroupId);
      }
      copies.push({ sourceFaceId: face.id, faceId: randomUUID(), personGroupId });
    }

    const count = await this.personRepository.copyFacesToAsset(input.targetAssetId, copies);
    await this.queueMissingThumbnails(input.targetOwnerId, [...new Set(mapped.values())]);
    return count;
  }

  /**
   * Undoes a `partner-merge` correction: the faces it put on the recipient's person move to a new person
   * of the partner's person, which then follows the partner's edits like any other person copy.
   */
  async undoPartnerMerge(auth: AuthDto, entry: FaceCorrection): Promise<void> {
    if (entry.undoneAt) {
      throw conflict('already-undone', 'This change was already undone');
    }
    const link = await this.personRepository.getPartnerPersonLinkByCorrection(auth.user.id, entry.id);
    if (!link) {
      throw conflict('person-gone', 'The partner person this merge came from is no longer linked');
    }

    const faceIds = await this.personRepository.getPartnerMergedFaceIds(
      auth.user.id,
      link.sourcePersonGroupId,
      link.personGroupId,
    );
    const personGroupId = await this.createPersonCopy(
      {
        targetOwnerId: auth.user.id,
        partnerSharedById: link.partnerSharedById,
        sourceOwnerId: link.partnerSharedById,
        sourcePersonGroupId: link.sourcePersonGroupId,
        fallbackName: entry.fromPersonName ?? '',
      },
      { correctionId: entry.id, personGroupId: link.personGroupId, faceIds },
    );
    await this.queueMissingThumbnails(auth.user.id, [personGroupId]);
  }

  /**
   * Pushes a person's name, birth date and hidden state into every copy that still follows it, skipping the
   * fields each copy's owner changed, then onward to the copies of those copies (A to B to C).
   */
  async propagatePerson(sourceOwnerId: string, sourcePersonGroupId: string): Promise<void> {
    const seen = new Set<string>([`${sourceOwnerId}/${sourcePersonGroupId}`]);
    const queue: Array<{ ownerId: string; personGroupId: string }> = [
      { ownerId: sourceOwnerId, personGroupId: sourcePersonGroupId },
    ];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const source = await this.personRepository.getByGroupId(current);
      if (!source) {
        continue;
      }
      const followers = await this.partnerOriginRepository.getPersonFollowers(current.ownerId, current.personGroupId);
      for (const follower of followers) {
        const key = `${follower.ownerId}/${follower.personGroupId}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        const overridden = new Set(follower.overriddenFields);
        const values = {
          ...(!overridden.has('name') && { name: source.name }),
          ...(!overridden.has('birthDate') && { birthDate: source.birthDate }),
          ...(!overridden.has('hidden') && { isHidden: source.isHidden }),
        };
        if (Object.keys(values).length > 0) {
          await this.personRepository.update({
            ownerId: follower.ownerId,
            personGroupId: follower.personGroupId,
            ...values,
          });
        }
        queue.push({ ownerId: follower.ownerId, personGroupId: follower.personGroupId });
      }
    }
  }

  /** Records which followed details the owner of a person copy just changed, so they stop following. */
  async noteEdit(ownerId: string, personGroupId: string, edit: PersonEdit): Promise<void> {
    const fields = [
      edit.name !== undefined && 'name',
      edit.birthDate !== undefined && 'birthDate',
      edit.isHidden !== undefined && 'hidden',
      edit.featureFaceAssetId !== undefined && 'cover',
      edit.isFavorite !== undefined && 'favorite',
      edit.color !== undefined && 'color',
    ].filter((field): field is string => !!field);
    if (fields.length === 0) {
      return;
    }
    await this.partnerOriginRepository.markPersonOverridden(ownerId, [personGroupId], fields);
  }

  /** Whether a person edit touched a detail its copies follow. */
  static touchesFollowedFields(edit: PersonEdit): boolean {
    return FOLLOWED_PERSON_FIELDS.some((field) => edit[field === 'hidden' ? 'isHidden' : field] !== undefined);
  }

  private async resolvePerson(input: {
    targetOwnerId: string;
    partnerSharedById: string;
    sourceOwnerId: string;
    sourcePersonGroupId: string;
    sampleFaceId?: string;
  }): Promise<string> {
    const { targetOwnerId, partnerSharedById, sourceOwnerId, sourcePersonGroupId } = input;
    const link = await this.personRepository.getPartnerPersonLink(targetOwnerId, sourcePersonGroupId);
    if (link) {
      return link.personGroupId;
    }
    const origin = await this.partnerOriginRepository.getPersonMapping(targetOwnerId, sourcePersonGroupId);
    if (origin) {
      return origin.personGroupId;
    }

    const save = (personGroupId: string, kind: PartnerPersonLink['kind'], correctionId: string | null = null) =>
      this.personRepository.savePartnerPersonLink({
        ownerId: targetOwnerId,
        sourcePersonGroupId,
        personGroupId,
        kind,
        partnerSharedById,
        correctionId,
      });

    const target = await this.userRepository.get(targetOwnerId, {});
    const clusterGroupId = target?.clusterGroupId;

    // the same identity already: both accounts share a recognition group and the recipient has the person
    if (clusterGroupId && (await this.personRepository.getGroupClusterId(sourcePersonGroupId)) === clusterGroupId) {
      const own = await this.personRepository.getByGroupId({
        ownerId: targetOwnerId,
        personGroupId: sourcePersonGroupId,
      });
      if (own) {
        await save(sourcePersonGroupId, 'merged');
        return sourcePersonGroupId;
      }
    }

    let match: { personGroupId: string; name: string } | undefined;
    if (clusterGroupId && input.sampleFaceId) {
      match = await this.findMatch(input.sampleFaceId, clusterGroupId, targetOwnerId);
    }
    if (match) {
      const sourcePerson = await this.personRepository.getByGroupId({
        ownerId: sourceOwnerId,
        personGroupId: sourcePersonGroupId,
      });
      const [correction] = await this.personRepository.recordFaceCorrections([
        {
          ownerId: targetOwnerId,
          actorId: targetOwnerId,
          action: 'partner-merge',
          faceId: null,
          // the partner's person, so the history names it (it is never one of the owner's people)
          fromPersonId: sourcePersonGroupId,
          toPersonId: match.personGroupId,
          fromPersonName: sourcePerson?.name ?? null,
          toPersonName: match.name,
        },
      ]);
      await save(match.personGroupId, 'merged', correction?.id ?? null);
      return match.personGroupId;
    }

    const personGroupId = await this.createPersonCopy({
      targetOwnerId,
      partnerSharedById,
      sourceOwnerId,
      sourcePersonGroupId,
      fallbackName: '',
    });
    return personGroupId;
  }

  /** Select only after face writes settle; the recipient's existing featured face stays their choice. */
  private async queueMissingThumbnails(ownerId: string, personGroupIds: string[]) {
    if (personGroupIds.length === 0) {
      return;
    }
    const selected = await this.personRepository
      .selectionForThumbnails(false, ownerId)
      .where('person.personGroupId', 'in', personGroupIds)
      .where('person.faceAssetId', 'is', null)
      .execute();
    if (selected.length > 0) {
      await this.jobRepository.collectFollowups(() =>
        this.jobRepository.queueAll(selected.map(({ data }) => ({ name: JobName.PersonGenerateThumbnail, data }))),
      );
    }
  }

  /** The recipient's closest own person within the recognition threshold, if any. */
  private async findMatch(faceId: string, clusterGroupId: string, ownerId: string) {
    const embedding = await this.personRepository.getFaceEmbedding(faceId);
    if (!embedding) {
      return;
    }
    const { machineLearning } = await this.getConfig({ withCache: true });
    const matches = await this.searchRepository.searchFaces({
      clusterGroupId,
      embedding,
      maxDistance: machineLearning.facialRecognition.maxDistance,
      numResults: 10,
      hasPerson: true,
    });
    for (const candidate of matches) {
      if (!candidate.personGroupId) {
        continue;
      }
      const person = await this.personRepository.getByGroupId({ ownerId, personGroupId: candidate.personGroupId });
      if (person) {
        return { personGroupId: person.personGroupId, name: person.name };
      }
    }
  }

  private async createPersonCopy(
    input: {
      targetOwnerId: string;
      partnerSharedById: string;
      sourceOwnerId: string;
      sourcePersonGroupId: string;
      fallbackName: string;
    },
    undo?: PersonCopyUndo,
  ): Promise<string> {
    const { targetOwnerId, sourceOwnerId, sourcePersonGroupId } = input;
    const source = await this.personRepository.getByGroupId({
      ownerId: sourceOwnerId,
      personGroupId: sourcePersonGroupId,
    });
    const rootOwnerId =
      (await this.personRepository.getPersonOriginRoot(sourceOwnerId, sourcePersonGroupId)) ?? sourceOwnerId;
    const result = await this.partnerOriginRepository.createPersonCopy(
      {
        ownerId: targetOwnerId,
        sourceOwnerId,
        sourcePersonGroupId,
        rootOwnerId,
        partnerSharedById: input.partnerSharedById,
        name: source?.name ?? input.fallbackName,
        birthDate: source?.birthDate ?? null,
        isHidden: source?.isHidden ?? false,
      },
      undo,
    );
    if ('conflict' in result) {
      throw conflict(
        result.conflict,
        result.conflict === 'already-undone'
          ? 'This change was already undone'
          : 'The partner person this merge came from is no longer linked',
      );
    }
    return result.personGroupId;
  }
}
