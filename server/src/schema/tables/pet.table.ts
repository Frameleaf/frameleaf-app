import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Index,
  PrimaryGeneratedColumn,
  Table,
  Unique,
  UpdateDateColumn,
} from '@immich/sql-tools';
import type { Generated, Timestamp } from '@immich/sql-tools';
import { PetObservationSource, PetObservationState, PetSpecies } from 'src/enum.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * Pet identities and recognition review (FL-58).
 *
 * The four tables here are deliberately split along one line: what the owner decided,
 * and what a model produced.
 *
 * Durable (never written by a recognition job):
 *   - `pet`             the identity itself: name, species, birthday, featured asset,
 *                       hidden and favorite.
 *   - `pet_observation` the owner's decision about one asset: this pet is in it
 *                       (`confirmed`) or is not (`rejected`). Drawn by hand or made by
 *                       accepting/rejecting a proposal, but stored the same way either
 *                       way, so the record outlives the proposal it came from.
 *
 * Replaceable (a recognition run may delete and rewrite all of it):
 *   - `pet_detection`   one region a model found in one asset, tagged with the exact
 *                       model name and revision that produced it.
 *   - `pet_candidate`   a proposal that a detection belongs to a pet.
 *
 * Because a candidate hangs off a detection and never off an observation, reprocessing
 * cannot erase a manual choice: `ON DELETE CASCADE` only ever reaches the replaceable
 * side. The review queue in turn hides any detection whose asset already carries a
 * durable observation for the proposed pet, so an earlier "not this pet" stays applied
 * after the model changes. See `src/utils/pets.ts` for those rules as pure functions.
 *
 * No embedding is stored here. Recognition (FL-58, `PetRecognitionService`) reads the CLIP
 * embedding smart search already keeps per photo in `smart_search`, so a detection is a
 * whole-photo reading tagged with the CLIP model and matcher revision. A per-region pet model,
 * if one is ever qualified (FL-145), would bring its own embedding table on the replaceable side.
 *
 * These tables carry no `updateId` and no `updatedAt` trigger: pets are not part of the
 * mobile sync protocol, and `updatedAt` is written explicitly by `PetRepository`.
 */
@Index({ columns: ['ownerId', 'isHidden'] })
@Table('pet')
export class PetTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  ownerId!: string;

  @Column({ default: '' })
  name!: Generated<string>;

  @Column({ default: PetSpecies.Other })
  species!: Generated<PetSpecies>;

  @Column({ type: 'date', nullable: true })
  birthDate!: Timestamp | null;

  /** Thumbnail source for the grid. `SET NULL` so deleting the photo keeps the pet. */
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  featuredAssetId!: string | null;

  @Column({ type: 'boolean', default: false })
  isHidden!: Generated<boolean>;

  @Column({ type: 'boolean', default: false })
  isFavorite!: Generated<boolean>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}

@Unique({ columns: ['petId', 'assetId'] })
@Table('pet_observation')
export class PetObservationTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  // [petId, assetId] is the unique constraint, which already indexes petId
  @ForeignKeyColumn(() => PetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  petId!: string;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  assetId!: string;

  /** `confirmed` means the pet is in this asset, `rejected` means it is not. */
  @Column({ default: PetObservationState.Confirmed })
  state!: Generated<PetObservationState>;

  /** Whether the owner drew the region or reviewed a proposal. Both are durable. */
  @Column({ default: PetObservationSource.Manual })
  source!: Generated<PetObservationSource>;

  /**
   * The region, in the pixel space of `imageWidth` x `imageHeight`. Null when the owner
   * named a whole photo rather than drawing, and null on a rejection.
   */
  @Column({ type: 'integer', nullable: true })
  boundingBoxX1!: number | null;

  @Column({ type: 'integer', nullable: true })
  boundingBoxY1!: number | null;

  @Column({ type: 'integer', nullable: true })
  boundingBoxX2!: number | null;

  @Column({ type: 'integer', nullable: true })
  boundingBoxY2!: number | null;

  @Column({ type: 'integer', nullable: true })
  imageWidth!: number | null;

  @Column({ type: 'integer', nullable: true })
  imageHeight!: number | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  /**
   * The asset checksum when this decision was made. A write that names the checksum it was looking
   * at is refused once the original has changed. Added by the fork migration
   * 0000000000176-PetObservationSourceAndRecognitionRuns, so it is kept out of the schema generator
   * (`synchronize: false`) while the Kysely types still carry it.
   */
  @Column({ type: 'bytea', nullable: true, synchronize: false })
  sourceChecksum!: Buffer | null;

  /**
   * Set when the original was replaced after a region was drawn on it: the region may no longer
   * point at the animal. The observation and the identity it confirms stay; the owner reviews it.
   */
  @Column({ type: 'timestamp with time zone', nullable: true, synchronize: false })
  staleAt!: Timestamp | null;
}

@Index({ columns: ['modelName', 'modelRevision'] })
@Table('pet_detection')
export class PetDetectionTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  assetId!: string;

  @Column({ type: 'integer', default: 0 })
  boundingBoxX1!: Generated<number>;

  @Column({ type: 'integer', default: 0 })
  boundingBoxY1!: Generated<number>;

  @Column({ type: 'integer', default: 0 })
  boundingBoxX2!: Generated<number>;

  @Column({ type: 'integer', default: 0 })
  boundingBoxY2!: Generated<number>;

  @Column({ type: 'integer', default: 0 })
  imageWidth!: Generated<number>;

  @Column({ type: 'integer', default: 0 })
  imageHeight!: Generated<number>;

  /** What the detector thought it was. Never overwrites the owner's `pet.species`. */
  @Column({ type: 'character varying', nullable: true, default: null })
  species!: string | null;

  @Column({ type: 'double precision', default: 0 })
  score!: Generated<number>;

  /**
   * Exactly which model produced this row. A recognition run deletes the detections of
   * its own asset whose `modelName`/`modelRevision` differ and inserts fresh ones, so a
   * revision change is a full replacement of the replaceable side and nothing else.
   */
  @Column()
  modelName!: string;

  @Column()
  modelRevision!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}

@Unique({ columns: ['detectionId', 'petId'] })
@Table('pet_candidate')
export class PetCandidateTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  // [detectionId, petId] is the unique constraint, which already indexes detectionId
  @ForeignKeyColumn(() => PetDetectionTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  detectionId!: string;

  @ForeignKeyColumn(() => PetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  petId!: string;

  @Column({ type: 'double precision', default: 0 })
  score!: Generated<number>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
