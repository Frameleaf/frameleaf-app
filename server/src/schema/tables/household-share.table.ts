import {
  Check,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  Table,
  Unique,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { PrimaryGeneratedUuidV7Column } from 'src/decorators.js';
import { AlbumTable } from 'src/schema/tables/album.table.js';
import { HouseholdLinkTable } from 'src/schema/tables/household-link.table.js';

/** FL-979: one shared space offered over one household link. The album always has `kind = 'space'`. */
@Table('household_share')
@Unique({ columns: ['albumId', 'linkId'] })
export class HouseholdShareTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @ForeignKeyColumn(() => AlbumTable, { onDelete: 'CASCADE', nullable: false, index: false })
  albumId!: string;

  @ForeignKeyColumn(() => HouseholdLinkTable, { onDelete: 'CASCADE', nullable: false })
  linkId!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}

/**
 * FL-979: one account on the other household's server invited to a share, by its user id there. No local
 * account exists for it. `displayName` is the name that server's directory gave when the owner invited it;
 * no email address is ever stored. `role` is text so that a later role needs no enum change.
 */
@Table('household_share_member')
@Check({
  name: 'household_share_member_role_check',
  expression: `role = ANY (ARRAY['viewer'::text, 'contributor'::text])`,
})
export class HouseholdShareMemberTable {
  @ForeignKeyColumn(() => HouseholdShareTable, { onDelete: 'CASCADE', nullable: false, primary: true, index: false })
  shareId!: string;

  @PrimaryColumn({ type: 'uuid' })
  remoteUserId!: string;

  @Column({ type: 'text' })
  displayName!: string;

  @Column({ type: 'text' })
  role!: string;

  @CreateDateColumn()
  invitedAt!: Generated<Timestamp>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  acceptedAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  leftAt!: Timestamp | null;
}

/**
 * FL-979: the change feed of a share. One row per item or person the share has ever named; a change moves the
 * row to a new `seq`, so a reader resuming from any cursor meets every entry in its latest state. The row holds
 * ids only: what the other household is told about it is decided when a manifest page is read.
 */
@Table('household_share_change')
@Unique({ columns: ['shareId', 'kind', 'entityId'] })
@Index({ name: 'household_share_change_shareId_seq_idx', columns: ['shareId', 'seq'] })
@Check({
  name: 'household_share_change_kind_check',
  expression: `kind = ANY (ARRAY['asset'::text, 'person'::text, 'comment'::text, 'space'::text])`,
})
export class HouseholdShareChangeTable {
  // ponytail: sql-tools' identity strategy is `integer`, not `bigint`: 2^31 changes across every share of this
  // server. Each change spends one, a Locked-rule change one per item the owner has in shared spaces.
  @PrimaryGeneratedColumn({ strategy: 'identity' })
  seq!: Generated<number>;

  @ForeignKeyColumn(() => HouseholdShareTable, { onDelete: 'CASCADE', nullable: false, index: false })
  shareId!: string;

  @Column({ type: 'text' })
  kind!: string;

  @Column({ type: 'uuid' })
  entityId!: string;

  @CreateDateColumn()
  changedAt!: Generated<Timestamp>;
}
