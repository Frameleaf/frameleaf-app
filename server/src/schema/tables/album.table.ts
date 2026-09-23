import {
  Check,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  ForeignKeyColumn,
  Index,
  PrimaryGeneratedColumn,
  Table,
  Trigger,
  UpdateDateColumn,
} from '@immich/sql-tools';
import type { Generated, Timestamp } from '@immich/sql-tools';
import { UpdateIdColumn, UpdatedAtTrigger } from 'src/decorators.js';
import { AlbumKind, AssetOrder } from 'src/enum.js';
import { album_parent_cycle_check } from 'src/schema/functions.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';

@Table({ name: 'album' })
@UpdatedAtTrigger('album_updatedAt')
// DB-level cycle guard for the closure tree (migration 2100000000020). The
// migration fires it on `INSERT OR UPDATE OF "parentId"`; the generator cannot
// express the column list, but the action set + timing match so the schema is
// still in sync.
@Trigger({
  name: 'album_parent_cycle_check_trigger',
  timing: 'before',
  actions: ['insert', 'update'],
  scope: 'row',
  functionName: album_parent_cycle_check.name,
})
// Partial index for FK lookups by parent (created in 1779700000000). The FK
// auto-index is suppressed (`index: false` below) so this partial one wins.
@Index({ name: 'album_parentId_idx', columns: ['parentId'], where: '("parentId" IS NOT NULL)' })
// Partial indexes backing the "siblings in display order" queries (1779900000000).
@Index({ name: 'album_parent_sort_idx', columns: ['parentId', 'sortOrder'], where: '("parentId" IS NOT NULL)' })
@Index({ name: 'album_root_sort_idx', columns: ['sortOrder'], where: '("parentId" IS NULL)' })
// Mirrors the CHECK created in migration 2100000000080. The constraint comparer
// strips parens before comparing, so the postgres-normalized expression matches.
@Check({
  name: 'album_kind_check',
  expression: `kind = ANY (ARRAY['album'::text, 'collection'::text, 'space'::text])`,
})
export class AlbumTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @Column({ default: 'Untitled Album' })
  albumName!: Generated<string>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @ForeignKeyColumn(() => AssetTable, {
    nullable: true,
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    comment: 'Asset ID to be used as thumbnail',
  })
  albumThumbnailAssetId!: string | null;

  @ForeignKeyColumn(() => AlbumTable, {
    nullable: true,
    onDelete: 'CASCADE',
    // Auto-FK-index suppressed: the partial `album_parentId_idx` declared on the
    // class is used instead (see migration 1779700000000).
    index: false,
    comment: 'Parent album ID for nesting (null = top-level)',
  })
  parentId!: string | null;

  @Column({ type: 'character varying', nullable: true, default: null })
  icon!: string | null;

  @Column({ type: 'double precision', nullable: true, default: null })
  sortOrder!: number | null;

  /** album holds photos; collection groups albums one level deep; space is a shared top-level library. */
  @Column({ type: 'text', default: AlbumKind.Album })
  kind!: Generated<AlbumKind>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @DeleteDateColumn()
  deletedAt!: Timestamp | null;

  @Column({ type: 'boolean', default: true })
  isActivityEnabled!: Generated<boolean>;

  @Column({ default: AssetOrder.Desc })
  order!: Generated<AssetOrder>;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;
}
