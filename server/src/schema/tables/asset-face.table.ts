import {
  AfterDeleteTrigger,
  Column,
  DeleteDateColumn,
  ForeignKeyColumn,
  Index,
  PrimaryGeneratedColumn,
  Table,
  UpdateDateColumn,
} from '@immich/sql-tools';
import type { Generated, Timestamp } from '@immich/sql-tools';
import { UpdateIdColumn, UpdatedAtTrigger } from 'src/decorators.js';
import { SourceType } from 'src/enum.js';
import { asset_face_source_type } from 'src/schema/enums.js';
import { asset_face_audit } from 'src/schema/functions.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { PersonGroupTable } from 'src/schema/tables/person-group.table.js';

@Table({ name: 'asset_face' })
@UpdatedAtTrigger('asset_face_updatedAt')
@AfterDeleteTrigger({
  scope: 'statement',
  function: asset_face_audit,
  referencingOldTableAs: 'old',
  when: 'pg_trigger_depth() = 0',
})
// schemaFromDatabase does not preserve column order
@Index({ name: 'asset_face_assetId_personGroupId_idx', columns: ['assetId', 'personGroupId'] })
@Index({
  name: 'asset_face_personGroupId_assetId_notDeleted_isVisible_idx',
  columns: ['personGroupId', 'assetId'],
  where: '"deletedAt" IS NULL AND "isVisible" IS TRUE',
})
@Index({ columns: ['personGroupId', 'assetId'] })
export class AssetFaceTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => AssetTable, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    // [assetId, personGroupId] is the PK constraint
    index: false,
  })
  assetId!: string;

  @ForeignKeyColumn(() => PersonGroupTable, {
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    nullable: true,
    // [personGroupId, assetId] makes this redundant
    index: false,
  })
  personGroupId!: string | null;

  @Column({ default: 0, type: 'integer' })
  imageWidth!: Generated<number>;

  @Column({ default: 0, type: 'integer' })
  imageHeight!: Generated<number>;

  @Column({ default: 0, type: 'integer' })
  boundingBoxX1!: Generated<number>;

  @Column({ default: 0, type: 'integer' })
  boundingBoxY1!: Generated<number>;

  @Column({ default: 0, type: 'integer' })
  boundingBoxX2!: Generated<number>;

  @Column({ default: 0, type: 'integer' })
  boundingBoxY2!: Generated<number>;

  @Column({ default: SourceType.MachineLearning, enum: asset_face_source_type })
  sourceType!: Generated<SourceType>;

  /**
   * Frameleaf FL-57: stamped whenever a human moves this face between people
   * (`PersonRepository.reassignFace`), distinct from `sourceType` (which only
   * distinguishes how the face was *detected*, not whether its *assignment* was
   * later corrected by a person). Never touched by the facial-recognition job,
   * so reprocessing a face's embedding or re-running clustering cannot silently
   * erase a manual correction. Backs the person detail "correction history" view.
   *
   * `Generated<>` (with a DB-side `DEFAULT NULL`, like `sourceType` above) so
   * every existing insert path — `createFace`, the facial-recognition job, test
   * factories — keeps compiling without knowing this column exists; only the
   * explicit reassignment path sets it.
   */
  @Column({ type: 'timestamp with time zone', nullable: true, default: null, index: true })
  correctedAt!: Generated<Timestamp | null>;

  @DeleteDateColumn()
  deletedAt!: Timestamp | null;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @UpdateIdColumn()
  updateId!: Generated<string>;

  @Column({ type: 'boolean', default: true })
  isVisible!: Generated<boolean>;
}
