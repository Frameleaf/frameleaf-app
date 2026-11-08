import { Check, Column, CreateDateColumn, ForeignKeyColumn, Index, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { PrimaryGeneratedUuidV7Column } from 'src/decorators.js';
import { UserTable } from 'src/schema/tables/user.table.js';

export enum AlbumChangeRunKind {
  Merge = 'merge',
  Cleanup = 'cleanup',
  Heal = 'heal',
}

export enum AlbumChangeRunStatus {
  Running = 'running',
  Done = 'done',
  Failed = 'failed',
  Undone = 'undone',
}

/**
 * FL-1298: one merge, cleanup or date healing, as the person experienced it. The latest run a person
 * has not undone can be undone for 30 days; `album_change` holds what it changed.
 */
@Table('album_change_run')
@Index({ name: 'album_change_run_userId_createdAt_idx', columns: ['userId', 'createdAt'] })
@Check({
  name: 'album_change_run_kind_check',
  expression: `kind = ANY (ARRAY['merge'::text, 'cleanup'::text, 'heal'::text])`,
})
@Check({
  name: 'album_change_run_status_check',
  expression: `status = ANY (ARRAY['running'::text, 'done'::text, 'failed'::text, 'undone'::text])`,
})
export class AlbumChangeRunTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false, index: false })
  userId!: string;

  @Column({ type: 'text' })
  kind!: AlbumChangeRunKind;

  @Column({ type: 'text', default: AlbumChangeRunStatus.Running })
  status!: Generated<AlbumChangeRunStatus>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  undoneAt!: Timestamp | null;

  /** What the run did, for its confirmation message and Library Care: names, counts. */
  @Column({ type: 'jsonb', default: '{}' })
  summary!: Generated<Record<string, unknown>>;
}
