import { Injectable } from '@nestjs/common';
import { sql, type Insertable, type Kysely, type Selectable, type Updateable } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { PetObservationState } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import {
  PetCandidateTable,
  PetDetectionTable,
  PetObservationTable,
  PetTable,
} from 'src/schema/tables/pet.table.js';
import {
  anyUuid,
  getHiddenContentFilter,
  hiddenContentAssetIdExists,
  isLockedAsset,
  lockedOwnerScope,
} from 'src/utils/database.js';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import type { LockedVisibilityOptions } from 'src/utils/locked-visibility.js';

export type Pet = Selectable<PetTable>;
export type PetObservation = Selectable<PetObservationTable>;
export type PetDetection = Selectable<PetDetectionTable>;

export interface PetWithCounts extends Pet {
  /** Durable `confirmed` observations. Never a count of detections. */
  assetCount: number;
}

/**
 * `lockedOwnerId`: the owner, when their session is elevated. Only then do counts, observations and
 * proposals include their Locked media (FL-34). `withLocked` is for writes that must see every
 * observation (merging), never for a response.
 */
type PetListOptions = { withHidden: boolean } & HiddenContentQueryOptions & LockedVisibilityOptions;

export type PetLockedOptions = LockedVisibilityOptions & { withLocked?: boolean };

export interface PetReviewCandidate {
  id: string;
  score: number;
  petId: string;
  assetId: string;
  detectionId: string;
  detectedSpecies: string | null;
  modelName: string;
  modelRevision: string;
  boundingBoxX1: number;
  boundingBoxY1: number;
  boundingBoxX2: number;
  boundingBoxY2: number;
  imageWidth: number;
  imageHeight: number;
}

/**
 * Pet identities and recognition review (FL-58).
 *
 * Every read and write here is filtered by `pet.ownerId` (and, for anything reached
 * through an asset, by `asset.ownerId`). The repository never widens access on its own;
 * the service still performs the asset access check before annotating an asset, but a
 * bug there cannot leak another account's pets through these queries.
 *
 * This repository carries no `@GenerateSql` decorators, matching the other fork-owned
 * repositories (`smart-album`, `media-health`), so it adds no file under `src/queries`.
 */
@Injectable()
export class PetRepository {
  constructor(
    @InjectKysely() private db: Kysely<DB>,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(PetRepository.name);
  }

  // ---------------------------------------------------------------- durable: identity

  /**
   * The owner's pets. With a hidden-content filter (a session that is not unlocked while the owner
   * suppresses content, FL-58) a pet behaves like a suppressed person or tag: a pet the owner
   * suppressed is left out, so is a pet whose every confirmed photo is hidden, and the count covers
   * only the photos that session may see. A pet with no confirmed photo yet stays listed, as an
   * empty tag does. The count includes the owner's Locked photos only in their elevated session
   * (`lockedOwnerId`, FL-34).
   */
  getAll(ownerId: string, { withHidden, lockedOwnerId, ...privacy }: PetListOptions): Promise<PetWithCounts[]> {
    const hiddenContent = getHiddenContentFilter(privacy);
    const visiblePhoto = hiddenContent
      ? sql<boolean>`not ${hiddenContentAssetIdExists(sql.ref('pet_observation.assetId'), hiddenContent)}`
      : undefined;
    const suppressedPetIds = hiddenContent?.petIds ?? [];
    return this.db
      .selectFrom('pet')
      .selectAll('pet')
      .select((eb) =>
        eb
          .selectFrom('pet_observation')
          .innerJoin('asset', 'asset.id', 'pet_observation.assetId')
          .whereRef('pet_observation.petId', '=', 'pet.id')
          .where('pet_observation.state', '=', PetObservationState.Confirmed)
          .where((eb) => lockedOwnerScope(eb, lockedOwnerId))
          .$if(!!visiblePhoto, (qb) => qb.where(visiblePhoto!))
          .select((inner) => inner.fn.countAll<number>().as('count'))
          .as('assetCount'),
      )
      .where('pet.ownerId', '=', ownerId)
      .$if(!withHidden, (qb) => qb.where('pet.isHidden', '=', false))
      .$if(suppressedPetIds.length > 0, (qb) => qb.where((eb) => eb.not(eb('pet.id', '=', anyUuid(suppressedPetIds)))))
      .$if(!!visiblePhoto, (qb) =>
        qb.where((eb) => {
          const confirmed = () =>
            eb
              .selectFrom('pet_observation')
              .select('pet_observation.id')
              .whereRef('pet_observation.petId', '=', 'pet.id')
              .where('pet_observation.state', '=', PetObservationState.Confirmed);
          return eb.or([eb.not(eb.exists(confirmed())), eb.exists(confirmed().where(visiblePhoto!))]);
        }),
      )
      // Favorites first and then oldest first, which is a stable order for paging. The
      // display order the design asks for (favorites, named alphabetically, unnamed last)
      // is applied in `web/src/lib/frameleaf/pets.ts`, where it is unit tested and where
      // the locale-aware comparison belongs.
      .orderBy('pet.isFavorite', 'desc')
      .orderBy('pet.createdAt', 'asc')
      .execute()
      .then((rows) => rows.map((row) => ({ ...row, assetCount: Number(row.assetCount ?? 0) })));
  }

  /** Owner-scoped by construction: a wrong owner gets `undefined`, never another's pet. */
  getById(
    ownerId: string,
    id: string,
    { lockedOwnerId }: LockedVisibilityOptions = {},
  ): Promise<PetWithCounts | undefined> {
    return this.db
      .selectFrom('pet')
      .selectAll('pet')
      .select((eb) =>
        eb
          .selectFrom('pet_observation')
          .innerJoin('asset', 'asset.id', 'pet_observation.assetId')
          .whereRef('pet_observation.petId', '=', 'pet.id')
          .where('pet_observation.state', '=', PetObservationState.Confirmed)
          .where((eb) => lockedOwnerScope(eb, lockedOwnerId))
          .select((inner) => inner.fn.countAll<number>().as('count'))
          .as('assetCount'),
      )
      .where('pet.id', '=', id)
      .where('pet.ownerId', '=', ownerId)
      .executeTakeFirst()
      .then((row) => (row ? { ...row, assetCount: Number(row.assetCount ?? 0) } : undefined));
  }

  getByIds(ownerId: string, ids: string[]): Promise<Pet[]> {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }

    return this.db
      .selectFrom('pet')
      .selectAll()
      .where('id', 'in', ids)
      .where('ownerId', '=', ownerId)
      .execute();
  }

  create(pet: Insertable<PetTable>): Promise<Pet> {
    return this.db.insertInto('pet').values(pet).returningAll().executeTakeFirstOrThrow();
  }

  update(ownerId: string, id: string, pet: Updateable<PetTable>): Promise<Pet | undefined> {
    return this.db
      .updateTable('pet')
      .set({ ...pet, updatedAt: new Date() })
      .where('id', '=', id)
      .where('ownerId', '=', ownerId)
      .returningAll()
      .executeTakeFirst();
  }

  async delete(ownerId: string, id: string): Promise<void> {
    await this.db.deleteFrom('pet').where('id', '=', id).where('ownerId', '=', ownerId).execute();
  }

  /** Whether an asset is one this owner may be shown as a pet's featured photo. */
  async isOwnedAsset(ownerId: string, assetId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('asset')
      .select('asset.id')
      .where('asset.id', '=', assetId)
      .where('asset.ownerId', '=', ownerId)
      .where('asset.deletedAt', 'is', null)
      .executeTakeFirst();
    return !!row;
  }

  /** Whether an asset is this owner's own and locked (FL-34), which is never a featured photo (FL-53). */
  async isOwnLockedAsset(ownerId: string, assetId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('asset')
      .select('asset.id')
      .where('asset.id', '=', assetId)
      .where('asset.ownerId', '=', ownerId)
      .where((eb) => isLockedAsset(eb))
      .executeTakeFirst();
    return !!row;
  }

  // ------------------------------------------------------------- durable: observations

  getObservations(ownerId: string, petId: string, options: PetLockedOptions = {}): Promise<PetObservation[]> {
    return this.db
      .selectFrom('pet_observation')
      .innerJoin('pet', 'pet.id', 'pet_observation.petId')
      .innerJoin('asset', 'asset.id', 'pet_observation.assetId')
      .selectAll('pet_observation')
      .where('pet_observation.petId', '=', petId)
      .where('pet.ownerId', '=', ownerId)
      .$if(!options.withLocked, (qb) => qb.where((eb) => lockedOwnerScope(eb, options.lockedOwnerId)))
      .orderBy('pet_observation.createdAt', 'desc')
      .execute();
  }

  getObservationById(
    ownerId: string,
    id: string,
    { lockedOwnerId }: LockedVisibilityOptions = {},
  ): Promise<PetObservation | undefined> {
    return this.db
      .selectFrom('pet_observation')
      .innerJoin('pet', 'pet.id', 'pet_observation.petId')
      .innerJoin('asset', 'asset.id', 'pet_observation.assetId')
      .selectAll('pet_observation')
      .where('pet_observation.id', '=', id)
      .where('pet.ownerId', '=', ownerId)
      .where((eb) => lockedOwnerScope(eb, lockedOwnerId))
      .executeTakeFirst();
  }

  /**
   * Record or replace the owner's decision about one (pet, asset) pair.
   *
   * Upsert rather than insert: answering the same pairing again is a correction, not a
   * duplicate, and the unique constraint makes that explicit. Nothing in the recognition
   * path calls this.
   */
  upsertObservation(observation: Insertable<PetObservationTable>): Promise<PetObservation> {
    return this.db
      .insertInto('pet_observation')
      .values(observation)
      .onConflict((oc) =>
        oc.columns(['petId', 'assetId']).doUpdateSet({
          state: observation.state,
          source: observation.source,
          boundingBoxX1: observation.boundingBoxX1 ?? null,
          boundingBoxY1: observation.boundingBoxY1 ?? null,
          boundingBoxX2: observation.boundingBoxX2 ?? null,
          boundingBoxY2: observation.boundingBoxY2 ?? null,
          imageWidth: observation.imageWidth ?? null,
          imageHeight: observation.imageHeight ?? null,
          updatedAt: new Date(),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * The owner filter is repeated in the delete itself, not left to the caller's earlier
   * read, so a row that changed owner between the two statements is still not removed.
   */
  async deleteObservation(ownerId: string, id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('pet_observation')
      .where('id', '=', id)
      .where(
        'petId',
        'in',
        this.db.selectFrom('pet').select('pet.id').where('pet.ownerId', '=', ownerId),
      )
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0) > 0;
  }

  /** Every durable decision this owner has made, used to filter the review queue. */
  getDecisions(
    ownerId: string,
  ): Promise<Array<{ id: string; assetId: string; petId: string; state: PetObservationState }>> {
    return this.db
      .selectFrom('pet_observation')
      .innerJoin('pet', 'pet.id', 'pet_observation.petId')
      .select([
        'pet_observation.id as id',
        'pet_observation.assetId as assetId',
        'pet_observation.petId as petId',
        'pet_observation.state as state',
      ])
      .where('pet.ownerId', '=', ownerId)
      .execute();
  }

  // ------------------------------------------------------------------- merge (durable)

  /**
   * Move the whole durable side of one pet onto another, inside one transaction.
   *
   * `reassign`, `promote` and `discard` come from `planObservationMerge`, so the conflict
   * rule lives in a tested pure function rather than in SQL.
   */
  async mergeInto(
    ownerId: string,
    { sourceId, targetId, reassign, promote, discard }: {
      sourceId: string;
      targetId: string;
      reassign: string[];
      promote: string[];
      discard: string[];
    },
  ): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const owned = await tx
        .selectFrom('pet')
        .select('id')
        .where('id', 'in', [sourceId, targetId])
        .where('ownerId', '=', ownerId)
        .execute();

      if (owned.length !== 2) {
        // Re-checked inside the transaction so a concurrent delete or owner change
        // cannot let a merge land on a pet the caller no longer owns.
        return;
      }

      if (discard.length > 0) {
        await tx.deleteFrom('pet_observation').where('id', 'in', discard).execute();
      }

      if (promote.length > 0) {
        await tx
          .updateTable('pet_observation')
          .set({ state: PetObservationState.Confirmed, updatedAt: new Date() })
          .where('id', 'in', promote)
          .execute();
      }

      if (reassign.length > 0) {
        await tx
          .updateTable('pet_observation')
          .set({ petId: targetId, updatedAt: new Date() })
          .where('id', 'in', reassign)
          .execute();
      }

      // The candidates of the disappearing pet are replaceable; they go with it.
      await tx.deleteFrom('pet').where('id', '=', sourceId).where('ownerId', '=', ownerId).execute();
    });
  }

  // ----------------------------------------------------------- replaceable: model side

  /**
   * The review queue: proposals over this owner's own assets and this owner's own pets.
   *
   * Durable decisions are NOT filtered out here; the service applies
   * `filterReviewedCandidates`, so the rule that a rejection survives reprocessing is a
   * tested pure function rather than a join nobody reads.
   */
  getCandidates(
    ownerId: string,
    limit: number,
    { lockedOwnerId }: LockedVisibilityOptions = {},
  ): Promise<PetReviewCandidate[]> {
    return this.db
      .selectFrom('pet_candidate')
      .innerJoin('pet_detection', 'pet_detection.id', 'pet_candidate.detectionId')
      .innerJoin('pet', 'pet.id', 'pet_candidate.petId')
      .innerJoin('asset', 'asset.id', 'pet_detection.assetId')
      .select([
        'pet_candidate.id as id',
        'pet_candidate.score as score',
        'pet_candidate.petId as petId',
        'pet_detection.id as detectionId',
        'pet_detection.assetId as assetId',
        'pet_detection.species as detectedSpecies',
        'pet_detection.modelName as modelName',
        'pet_detection.modelRevision as modelRevision',
        'pet_detection.boundingBoxX1 as boundingBoxX1',
        'pet_detection.boundingBoxY1 as boundingBoxY1',
        'pet_detection.boundingBoxX2 as boundingBoxX2',
        'pet_detection.boundingBoxY2 as boundingBoxY2',
        'pet_detection.imageWidth as imageWidth',
        'pet_detection.imageHeight as imageHeight',
      ])
      .where('pet.ownerId', '=', ownerId)
      .where('asset.ownerId', '=', ownerId)
      .where('asset.deletedAt', 'is', null)
      .where((eb) => lockedOwnerScope(eb, lockedOwnerId))
      .limit(limit)
      .execute()
      .then((rows) => rows.map((row) => ({ ...row, score: Number(row.score ?? 0) })));
  }

  getCandidateById(
    ownerId: string,
    id: string,
    { lockedOwnerId }: LockedVisibilityOptions = {},
  ): Promise<PetReviewCandidate | undefined> {
    return this.db
      .selectFrom('pet_candidate')
      .innerJoin('pet_detection', 'pet_detection.id', 'pet_candidate.detectionId')
      .innerJoin('pet', 'pet.id', 'pet_candidate.petId')
      .innerJoin('asset', 'asset.id', 'pet_detection.assetId')
      .select([
        'pet_candidate.id as id',
        'pet_candidate.score as score',
        'pet_candidate.petId as petId',
        'pet_detection.id as detectionId',
        'pet_detection.assetId as assetId',
        'pet_detection.species as detectedSpecies',
        'pet_detection.modelName as modelName',
        'pet_detection.modelRevision as modelRevision',
        'pet_detection.boundingBoxX1 as boundingBoxX1',
        'pet_detection.boundingBoxY1 as boundingBoxY1',
        'pet_detection.boundingBoxX2 as boundingBoxX2',
        'pet_detection.boundingBoxY2 as boundingBoxY2',
        'pet_detection.imageWidth as imageWidth',
        'pet_detection.imageHeight as imageHeight',
      ])
      .where('pet_candidate.id', '=', id)
      .where('pet.ownerId', '=', ownerId)
      .where('asset.ownerId', '=', ownerId)
      .where((eb) => lockedOwnerScope(eb, lockedOwnerId))
      .executeTakeFirst()
      .then((row) => (row ? { ...row, score: Number(row.score ?? 0) } : undefined));
  }

  /** Remove every proposal made for one detection once the owner has answered it. */
  async deleteCandidatesForDetection(detectionId: string): Promise<void> {
    await this.db.deleteFrom('pet_candidate').where('detectionId', '=', detectionId).execute();
  }

  getDetectionsForAsset(assetId: string): Promise<PetDetection[]> {
    return this.db.selectFrom('pet_detection').selectAll().where('assetId', '=', assetId).execute();
  }

  /**
   * Replace the model side for one asset.
   *
   * `detectionIds` is always a list of `pet_detection` ids, so the cascade reaches
   * `pet_candidate` and stops. Nothing in this method can touch `pet` or
   * `pet_observation`; that is what makes a recognition rerun safe for manual choices.
   */
  async replaceDetections(
    assetId: string,
    detectionIds: string[],
    detections: Array<Omit<Insertable<PetDetectionTable>, 'assetId'>>,
  ): Promise<PetDetection[]> {
    return this.db.transaction().execute(async (tx) => {
      if (detectionIds.length > 0) {
        await tx.deleteFrom('pet_detection').where('id', 'in', detectionIds).where('assetId', '=', assetId).execute();
      }

      if (detections.length === 0) {
        return [];
      }

      return tx
        .insertInto('pet_detection')
        .values(detections.map((detection) => ({ ...detection, assetId })))
        .returningAll()
        .execute();
    });
  }

  async upsertCandidates(candidates: Array<Insertable<PetCandidateTable>>): Promise<void> {
    if (candidates.length === 0) {
      return;
    }

    await this.db
      .insertInto('pet_candidate')
      .values(candidates)
      .onConflict((oc) =>
        oc.columns(['detectionId', 'petId']).doUpdateSet((eb) => ({ score: eb.ref('excluded.score') })),
      )
      .execute();
  }
}
