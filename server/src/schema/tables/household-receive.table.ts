import {
  Check,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Index,
  PrimaryColumn,
  Table,
  Unique,
} from '@frameleaf/sql-tools';
import type { Generated, Int8, Timestamp } from '@frameleaf/sql-tools';
import { PrimaryGeneratedUuidV7Column } from 'src/decorators.js';
import { AlbumTable } from 'src/schema/tables/album.table.js';
import { HouseholdLinkTable } from 'src/schema/tables/household-link.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/** A face box as the other household's manifest listed it, kept until the recipient's own faces can be matched. */
export type HouseholdFaceBox = {
  assetId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  height: number;
};

/**
 * FL-994: one local account invited to one space of another household. Whether that person still receives is
 * decided here, per person: the sending server can only enforce a removal per household.
 */
@Table('household_inbound_share')
@Unique({ columns: ['linkId', 'remoteShareId', 'userId'] })
@Index({ name: 'household_inbound_share_userId_idx', columns: ['userId'] })
@Check({
  name: 'household_inbound_share_state_check',
  expression: `state = ANY (ARRAY['invited'::text, 'accepted'::text, 'left'::text])`,
})
export class HouseholdInboundShareTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @ForeignKeyColumn(() => HouseholdLinkTable, { onDelete: 'CASCADE', nullable: false, index: false })
  linkId!: string;

  @Column({ type: 'uuid' })
  remoteShareId!: string;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', nullable: false, index: false })
  userId!: string;

  /** The recipient's local space. Null until they accept, and after they delete it. */
  @ForeignKeyColumn(() => AlbumTable, { onDelete: 'SET NULL', nullable: true })
  albumId!: string | null;

  @Column({ type: 'text' })
  spaceName!: string;

  @Column({ type: 'text' })
  ownerName!: string;

  @Column({ type: 'text', default: 'invited' })
  state!: Generated<string>;

  /** The last manifest `seq` applied. */
  @Column({ type: 'integer', default: 0 })
  cursor!: Generated<number>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  lastPulledAt!: Timestamp | null;

  /** A short machine word: `over-quota`, `bad-page`, `file-too-large`, and so on. */
  @Column({ type: 'text', nullable: true })
  lastError!: string | null;

  @Column({ type: 'integer', default: 0 })
  failures!: Generated<number>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  nextPullAt!: Timestamp | null;

  /** One pull per share at a time, across workers: a lease renewed while it runs. */
  @Column({ type: 'timestamp with time zone', nullable: true })
  pullingUntil!: Timestamp | null;

  /** The sender could not be told this person left; the next poll tells it. */
  @Column({ type: 'boolean', default: false })
  leaveUnsent!: Generated<boolean>;

  /** The one interrupted download this share may keep, so a peer cannot leave partial files behind. */
  @Column({ type: 'text', nullable: true })
  partialPath!: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  reconcileStartedAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  lastReconciledAt!: Timestamp | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}

/**
 * FL-994: where a local item or person came from. The row outlives the local one, so something the recipient
 * deleted is never made again. Keyed by the remote id: the same local item can have come from two households.
 */
@Table('household_origin')
@Index({ name: 'household_origin_localId_kind_idx', columns: ['localId', 'kind'] })
@Index({ name: 'household_origin_userId_idx', columns: ['userId'] })
@Check({
  name: 'household_origin_kind_check',
  expression: `kind = ANY (ARRAY['asset'::text, 'album'::text, 'person'::text])`,
})
export class HouseholdOriginTable {
  @ForeignKeyColumn(() => HouseholdLinkTable, { onDelete: 'CASCADE', nullable: false, primary: true, index: false })
  linkId!: string;

  @PrimaryColumn({ type: 'uuid' })
  remoteId!: string;

  @PrimaryColumn({ type: 'text' })
  kind!: string;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', nullable: false, primary: true, index: false })
  userId!: string;

  /** No foreign key: the row stays as a tombstone after the local item is deleted. */
  @Column({ type: 'uuid' })
  localId!: string;

  @Column({ type: 'boolean', default: true })
  followUntilEdited!: Generated<boolean>;

  @Column({ type: 'text', array: true, default: [] })
  overriddenFields!: Generated<string[]>;

  /** False when the recipient already held this item or person: what they own is never written to. */
  @Column({ type: 'boolean', default: false })
  isCopy!: Generated<boolean>;

  /** The inbound shares that placed this item. */
  @Column({ type: 'uuid', array: true, default: [] })
  shareIds!: Generated<string[]>;

  /** A still's live video part, by the sender's id, until both have arrived and are paired. */
  @Column({ type: 'uuid', nullable: true })
  pairedRemoteId!: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  remoteUpdatedAt!: Timestamp | null;

  @CreateDateColumn()
  lastSeenAt!: Generated<Timestamp>;
}

/** FL-994: an original this server downloaded and verified from that link, so a second recipient need not. */
@Table('household_received_file')
export class HouseholdReceivedFileTable {
  @ForeignKeyColumn(() => HouseholdLinkTable, { onDelete: 'CASCADE', nullable: false, primary: true, index: false })
  linkId!: string;

  @PrimaryColumn({ type: 'bytea' })
  checksum!: Buffer;

  @Column({ type: 'text' })
  path!: string;

  @Column({ type: 'bigint' })
  size!: Int8;

  @CreateDateColumn()
  receivedAt!: Generated<Timestamp>;
}

/** FL-994: a person whose boxes wait for local face detection to finish on the received copies. */
@Table('household_person_pending')
export class HouseholdPersonPendingTable {
  @ForeignKeyColumn(() => HouseholdLinkTable, { onDelete: 'CASCADE', nullable: false, primary: true, index: false })
  linkId!: string;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', nullable: false, primary: true, index: false })
  userId!: string;

  @PrimaryColumn({ type: 'uuid' })
  remoteId!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'jsonb' })
  faces!: HouseholdFaceBox[];
}
