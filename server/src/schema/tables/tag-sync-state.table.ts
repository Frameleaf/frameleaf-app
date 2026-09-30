import { Column, ForeignKeyColumn, PrimaryColumn, Table } from '@immich/sql-tools';
import type { Generated } from '@immich/sql-tools';
import { UpdateIdColumn } from 'src/decorators.js';
import { SessionTable } from 'src/schema/tables/session.table.js';

/** Keys deliberately have no target FK: deletion must retain retryable revoke knowledge. */
@Table('session_tag_sync_state')
export class TagSyncStateTable {
  @ForeignKeyColumn(() => SessionTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true, index: false })
  sessionId!: string;
  @PrimaryColumn({ type: 'character varying' })
  kind!: 'tag' | 'assetTag' | 'pet' | 'petObservation' | 'space' | 'spaceMember' | 'duplicate' | 'pin';
  @PrimaryColumn({ type: 'character varying' })
  key!: string;
  @Column({ type: 'uuid' })
  entityId!: string;
  @Column({ type: 'uuid', nullable: true })
  assetId!: string | null;
  @Column({ type: 'uuid' })
  sourceId!: string;
  @UpdateIdColumn({ index: true })
  eventId!: Generated<string>;
  /** Space identity delivery order is independent of its newest-first source order. */
  @Column({ type: 'bigint', nullable: true })
  deliveryOrder!: number | null;
  @Column({ type: 'text' })
  action!: 'upsert' | 'delete';
  @Column({ type: 'boolean', default: false })
  delivered!: Generated<boolean>;
  @Column({ type: 'boolean', default: false })
  acknowledged!: Generated<boolean>;
  @Column({ type: 'boolean', default: false })
  potentiallyVisible!: Generated<boolean>;
  @Column({ type: 'boolean', default: false })
  confirmedVisible!: Generated<boolean>;
}
