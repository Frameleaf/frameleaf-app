import { Injectable } from '@nestjs/common';
import { type Insertable, type Kysely, type Selectable, type Transaction, type Updateable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { AssetVisibility } from 'src/enum.js';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { lockForkWrites } from 'src/utils/fork-write-lock.js';
import type { LockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { PetObservationState, PetRecognitionRunStatus, PetSpecies, VectorIndex } from 'src/enum.js';
import { probes } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { PetCandidateTable, PetDetectionTable, PetObservationTable, PetTable } from 'src/schema/tables/pet.table.js';
import {
  anyUuid,
  getHiddenContentFilter,
  hiddenContentAssetIdExists,
  isLockedAsset,
  lockedOwnerScope,
} from 'src/utils/database.js';

export type Pet = Selectable<PetTable>;
export type PetObservation = Selectable<PetObservationTable>;
export type PetDetection = Selectable<PetDetectionTable>;

export interface RecognitionAsset {
  id: string;
  ownerId: string;
  visibility: AssetVisibility;
  deletedAt: Date | null;
  width: number | null;
  height: number | null;
  exifImageWidth: number | null;
  exifImageHeight: number | null;
  embedding: string;
}

/** An owner's latest pet recognition run (`immich_fork.pet_recognition_run`, FL-58). */
export interface PetRecognitionRun {
  ownerId: string;
  id: string;
  status: PetRecognitionRunStatus;
  assetCount: number;
  processedCount: number;
  proposalCount: number;
  destinationKind: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

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
  /** The asset's current checksum, which a review answer names so it lands on this original (FL-58). */
  assetChecksum: Buffer;
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
    return (
      this.db
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
        .$if(suppressedPetIds.length > 0, (qb) =>
          qb.where((eb) => eb.not(eb('pet.id', '=', anyUuid(suppressedPetIds)))),
        )
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
        .then((rows) => rows.map((row) => ({ ...row, assetCount: Number(row.assetCount ?? 0) })))
    );
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

    return this.db.selectFrom('pet').selectAll().where('id', 'in', ids).where('ownerId', '=', ownerId).execute();
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
  upsertObservation(
    observation: Omit<Insertable<PetObservationTable>, 'sourceChecksum' | 'staleAt'>,
  ): Promise<PetObservation> {
    // FL-58: the decision records the checksum of the original as it is now, read in the same
    // statement, and a fresh decision is never stale.
    const sourceChecksum = this.db
      .selectFrom('asset')
      .select('asset.checksum')
      .where('asset.id', '=', observation.assetId);
    return this.db
      .insertInto('pet_observation')
      .values({ ...observation, sourceChecksum, staleAt: null })
      .onConflict((oc) =>
        oc.columns(['petId', 'assetId']).doUpdateSet((eb) => ({
          state: observation.state,
          source: observation.source,
          boundingBoxX1: observation.boundingBoxX1 ?? null,
          boundingBoxY1: observation.boundingBoxY1 ?? null,
          boundingBoxX2: observation.boundingBoxX2 ?? null,
          boundingBoxY2: observation.boundingBoxY2 ?? null,
          imageWidth: observation.imageWidth ?? null,
          imageHeight: observation.imageHeight ?? null,
          sourceChecksum: eb.ref('excluded.sourceChecksum'),
          staleAt: null,
          updatedAt: new Date(),
        })),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** The current checksum of one of this owner's assets, or undefined when it is not theirs. */
  async getOwnedAssetChecksum(ownerId: string, assetId: string): Promise<Buffer | undefined> {
    const row = await this.db
      .selectFrom('asset')
      .select('asset.checksum')
      .where('asset.id', '=', assetId)
      .where('asset.ownerId', '=', ownerId)
      .executeTakeFirst();
    return row?.checksum;
  }

  /**
   * This owner's decisions about one asset, for the viewer's "Pets in this photo". Only the owner's
   * pets appear; a Locked asset is left out unless the owner's session is elevated.
   */
  getObservationsForAsset(
    ownerId: string,
    assetId: string,
    { lockedOwnerId }: LockedVisibilityOptions = {},
  ): Promise<PetObservation[]> {
    return this.db
      .selectFrom('pet_observation')
      .innerJoin('pet', 'pet.id', 'pet_observation.petId')
      .innerJoin('asset', 'asset.id', 'pet_observation.assetId')
      .selectAll('pet_observation')
      .where('pet_observation.assetId', '=', assetId)
      .where('pet.ownerId', '=', ownerId)
      .where((eb) => lockedOwnerScope(eb, lockedOwnerId))
      .orderBy('pet_observation.createdAt', 'asc')
      .execute();
  }

  /**
   * After an original was replaced (FL-58): every drawn region on it whose recorded checksum no
   * longer matches is marked stale for review. Nothing is deleted and no state changes, so the
   * identity the owner confirmed stays confirmed. Returns how many were flagged.
   */
  async flagStaleRegions(assetId: string): Promise<number> {
    const result = await this.db
      .updateTable('pet_observation')
      .set({ staleAt: new Date() })
      .from('asset')
      .whereRef('asset.id', '=', 'pet_observation.assetId')
      .where('pet_observation.assetId', '=', assetId)
      .where('pet_observation.boundingBoxX1', 'is not', null)
      .where('pet_observation.sourceChecksum', 'is not', null)
      .where('pet_observation.staleAt', 'is', null)
      .whereRef('pet_observation.sourceChecksum', '!=', 'asset.checksum')
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0);
  }

  /**
   * The owner filter is repeated in the delete itself, not left to the caller's earlier
   * read, so a row that changed owner between the two statements is still not removed.
   */
  async deleteObservation(ownerId: string, id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('pet_observation')
      .where('id', '=', id)
      .where('petId', 'in', this.db.selectFrom('pet').select('pet.id').where('pet.ownerId', '=', ownerId))
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

  /** The owner's decisions about one asset, in either direction: those pets are never proposed for it. */
  getDecisionsForAsset(
    ownerId: string,
    assetId: string,
  ): Promise<Array<{ petId: string; state: PetObservationState }>> {
    return this.db
      .selectFrom('pet_observation')
      .innerJoin('pet', 'pet.id', 'pet_observation.petId')
      .select(['pet_observation.petId as petId', 'pet_observation.state as state'])
      .where('pet.ownerId', '=', ownerId)
      .where('pet_observation.assetId', '=', assetId)
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
    {
      sourceId,
      targetId,
      reassign,
      promote,
      discard,
    }: {
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
        'asset.checksum as assetChecksum',
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
        'asset.checksum as assetChecksum',
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

  /**
   * Remove the proposals the owner just answered. Only the named pets' proposals go: a detection
   * made on the whole photo (FL-58, CLIP) can carry proposals for several pets that are all in it,
   * and answering one says nothing about the others.
   */
  async deleteCandidates(detectionId: string, petIds: string[]): Promise<void> {
    if (petIds.length === 0) {
      return;
    }
    await this.db
      .deleteFrom('pet_candidate')
      .where('detectionId', '=', detectionId)
      .where('petId', 'in', petIds)
      .execute();
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

  // --------------------------------------------------------- recognition inputs (FL-58)

  /**
   * One asset as pet recognition reads it: its owner, whether it may be read at all, its size for
   * the whole-photo region and its CLIP embedding from smart search. No embedding, no recognition.
   */
  getRecognitionAsset(assetId: string): Promise<RecognitionAsset | undefined> {
    return this.db
      .selectFrom('asset')
      .innerJoin('smart_search', 'smart_search.assetId', 'asset.id')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select([
        'asset.id',
        'asset.ownerId',
        'asset.visibility',
        'asset.deletedAt',
        'asset.width',
        'asset.height',
        'asset_exif.exifImageWidth',
        'asset_exif.exifImageHeight',
        sql<string>`smart_search.embedding::text`.as('embedding'),
      ])
      .where('asset.id', '=', assetId)
      .executeTakeFirst();
  }

  /**
   * What the owner has confirmed each of their visible pets in, as CLIP embeddings: at most
   * `perPet` photos per pet, newest decisions first. A region flagged stale still names the right
   * pet for the photo, so it counts; the photo being recognised never counts for itself.
   */
  async getRecognitionReferences(
    ownerId: string,
    excludeAssetId: string,
    perPet: number,
  ): Promise<Array<{ petId: string; species: PetSpecies; embedding: string }>> {
    const rows = await this.db
      .selectFrom((eb) =>
        eb
          .selectFrom('pet_observation')
          .innerJoin('pet', 'pet.id', 'pet_observation.petId')
          .innerJoin('asset', 'asset.id', 'pet_observation.assetId')
          .innerJoin('smart_search', 'smart_search.assetId', 'pet_observation.assetId')
          .select([
            'pet.id as petId',
            'pet.species as species',
            sql<string>`smart_search.embedding::text`.as('embedding'),
            sql<number>`row_number() over (partition by pet.id order by pet_observation."updatedAt" desc)`.as('rank'),
          ])
          .where('pet.ownerId', '=', ownerId)
          .where('pet.isHidden', '=', false)
          .where('pet_observation.state', '=', PetObservationState.Confirmed)
          .where('pet_observation.assetId', '!=', excludeAssetId)
          .where('asset.ownerId', '=', ownerId)
          .where('asset.deletedAt', 'is', null)
          .as('ranked'),
      )
      .select(['ranked.petId', 'ranked.species', 'ranked.embedding'])
      .where('ranked.rank', '<=', perPet)
      .execute();
    return rows as Array<{ petId: string; species: PetSpecies; embedding: string }>;
  }

  /** Whether this owner has confirmed any visible pet in any photo, which recognition needs to start. */
  async hasConfirmedObservations(ownerId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('pet_observation')
      .innerJoin('pet', 'pet.id', 'pet_observation.petId')
      .select('pet_observation.id')
      .where('pet.ownerId', '=', ownerId)
      .where('pet.isHidden', '=', false)
      .where('pet_observation.state', '=', PetObservationState.Confirmed)
      .limit(1)
      .executeTakeFirst();
    return !!row;
  }

  /** The owners with at least one confirmed pet photo; only their libraries are worth a run. */
  async getOwnersWithConfirmedPets(): Promise<string[]> {
    const rows = await this.db
      .selectFrom('pet')
      .innerJoin('pet_observation', 'pet_observation.petId', 'pet.id')
      .select('pet.ownerId')
      .where('pet.isHidden', '=', false)
      .where('pet_observation.state', '=', PetObservationState.Confirmed)
      .groupBy('pet.ownerId')
      .execute();
    return rows.map(({ ownerId }) => ownerId);
  }

  /** Every asset of one owner that has a CLIP embedding and is not in the trash. */
  getRecognizableAssetIds(ownerId: string): Promise<string[]> {
    return this.db
      .selectFrom('asset')
      .innerJoin('smart_search', 'smart_search.assetId', 'asset.id')
      .select('asset.id')
      .where('asset.ownerId', '=', ownerId)
      .where('asset.deletedAt', 'is', null)
      .orderBy('asset.id')
      .execute()
      .then((rows) => rows.map(({ id }) => id));
  }

  /**
   * The owner's photos that look most like one photo, by CLIP distance: where a newly confirmed pet
   * is most likely to be found again. Bounded by `limit`, owner's assets only.
   */
  async getNearestAssetIds(ownerId: string, assetId: string, limit: number): Promise<string[]> {
    const reference = await this.db
      .selectFrom('smart_search')
      .select(sql<string>`smart_search.embedding::text`.as('embedding'))
      .where('smart_search.assetId', '=', assetId)
      .executeTakeFirst();
    if (!reference) {
      return [];
    }
    // The CLIP index needs its probe count set, as `SearchRepository.searchSmart` does.
    return this.db.transaction().execute(async (trx) => {
      await sql`set local vchordrq.probes = ${sql.lit(probes[VectorIndex.Clip])}`.execute(trx);
      const rows = await trx
        .selectFrom('asset')
        .innerJoin('smart_search', 'smart_search.assetId', 'asset.id')
        .select('asset.id')
        .where('asset.ownerId', '=', ownerId)
        .where('asset.deletedAt', 'is', null)
        .where('asset.id', '!=', assetId)
        .orderBy(sql`smart_search.embedding <=> ${reference.embedding}`)
        .limit(limit)
        .execute();
      return rows.map(({ id }) => id);
    });
  }

  // ---------------------------------------------------------- recognition runs (FL-58)

  getRun(ownerId: string): Promise<PetRecognitionRun | undefined> {
    return sql<PetRecognitionRun>`
      SELECT * FROM immich_fork.pet_recognition_run WHERE "ownerId" = ${ownerId}
    `
      .execute(this.db)
      .then(({ rows }) => rows[0]);
  }

  /** Start (or restart) the owner's run: a new run id, so jobs of an earlier run stop counting. */
  startRun(ownerId: string, destinationKind: string | null): Promise<PetRecognitionRun> {
    return this.forkWrite((tx) =>
      sql<PetRecognitionRun>`
      INSERT INTO immich_fork.pet_recognition_run ("ownerId", id, status, "destinationKind")
      VALUES (${ownerId}, gen_random_uuid(), ${PetRecognitionRunStatus.Queued}, ${destinationKind})
      ON CONFLICT ("ownerId") DO UPDATE SET
        id = gen_random_uuid(),
        status = ${PetRecognitionRunStatus.Queued},
        "assetCount" = 0,
        "processedCount" = 0,
        "proposalCount" = 0,
        "destinationKind" = excluded."destinationKind",
        error = NULL,
        "createdAt" = clock_timestamp(),
        "updatedAt" = clock_timestamp(),
        "finishedAt" = NULL
      RETURNING *
    `
        .execute(tx)
        .then(({ rows }) => rows[0]),
    );
  }

  /**
   * Every pet_recognition_run write takes the fork-state lock first (as face_correction writes do),
   * so it is refused cleanly (ConflictException) during a database handoff.
   */
  private forkWrite<T>(write: (tx: Transaction<DB>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (tx) => {
      await lockForkWrites(tx, 'Pet recognition runs');
      return write(tx);
    });
  }

  /** The run found its assets; with none it is complete at once. Only the named run is touched. */
  async setRunAssets(runId: string, assetCount: number): Promise<void> {
    await this.forkWrite((tx) =>
      sql`
      UPDATE immich_fork.pet_recognition_run
      SET "assetCount" = ${assetCount},
        status = CASE WHEN ${assetCount}::integer = 0 THEN ${PetRecognitionRunStatus.Completed} ELSE ${PetRecognitionRunStatus.Running} END,
        "finishedAt" = CASE WHEN ${assetCount}::integer = 0 THEN clock_timestamp() ELSE NULL END,
        "updatedAt" = clock_timestamp()
      WHERE id = ${runId} AND status IN (${PetRecognitionRunStatus.Queued}, ${PetRecognitionRunStatus.Running})
    `.execute(tx),
    );
  }

  /** Whether the run a job belongs to is still wanted. A cancelled or replaced run is not. */
  async isRunActive(runId: string): Promise<boolean> {
    const { rows } = await sql<{ active: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM immich_fork.pet_recognition_run
        WHERE id = ${runId} AND status IN (${PetRecognitionRunStatus.Queued}, ${PetRecognitionRunStatus.Running})
      ) AS active
    `.execute(this.db);
    return !!rows[0]?.active;
  }

  /** One asset of the run is done; the last one completes the run. */
  async recordRunProgress(runId: string, proposals: number): Promise<void> {
    await this.forkWrite((tx) =>
      sql`
      UPDATE immich_fork.pet_recognition_run
      SET "processedCount" = LEAST("assetCount", "processedCount" + 1),
        "proposalCount" = "proposalCount" + ${proposals},
        status = CASE WHEN "processedCount" + 1 >= "assetCount" THEN ${PetRecognitionRunStatus.Completed} ELSE status END,
        "finishedAt" = CASE WHEN "processedCount" + 1 >= "assetCount" THEN clock_timestamp() ELSE "finishedAt" END,
        "updatedAt" = clock_timestamp()
      WHERE id = ${runId} AND status IN (${PetRecognitionRunStatus.Queued}, ${PetRecognitionRunStatus.Running})
    `.execute(tx),
    );
  }

  /** The owner cancelled; jobs still queued for this run see it and stop. Returns the run as it is now. */
  cancelRun(ownerId: string): Promise<PetRecognitionRun | undefined> {
    return this.forkWrite((tx) =>
      sql<PetRecognitionRun>`
      UPDATE immich_fork.pet_recognition_run
      SET status = ${PetRecognitionRunStatus.Cancelled}, "finishedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
      WHERE "ownerId" = ${ownerId} AND status IN (${PetRecognitionRunStatus.Queued}, ${PetRecognitionRunStatus.Running})
      RETURNING *
    `
        .execute(tx)
        .then(({ rows }) => rows[0]),
    );
  }

  async failRun(runId: string, error: string): Promise<void> {
    await this.forkWrite((tx) =>
      sql`
      UPDATE immich_fork.pet_recognition_run
      SET status = ${PetRecognitionRunStatus.Failed}, error = ${error.slice(0, 500)},
        "finishedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
      WHERE id = ${runId} AND status IN (${PetRecognitionRunStatus.Queued}, ${PetRecognitionRunStatus.Running})
    `.execute(tx),
    );
  }
}
