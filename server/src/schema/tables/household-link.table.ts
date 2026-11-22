import { Check, Column, CreateDateColumn, ForeignKeyColumn, Index, PrimaryColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { PrimaryGeneratedUuidV7Column } from 'src/decorators.js';

/** One address Frameleaf Cloud listed for the other household's server at the last grant. */
export type HouseholdLinkAddress = { kind: string; uri: string };

/**
 * FL-952: this server's side of a link with another household's server (Linked Households, FL-755).
 * `cloudLinkId` is the link's id at Frameleaf Cloud and the id both servers use on the peer API.
 * `peerPublicKey` is the other server's Ed25519 key (`x`) as Cloud introduced it at pairing; it is never
 * replaced afterwards. `peerName` is the other server's own name, as Cloud reports it. `state` is text so that a later state needs no enum change.
 */
@Table('household_link')
@Check({
  name: 'household_link_state_check',
  expression: `state = ANY (ARRAY['active'::text, 'paused'::text, 'ended'::text])`,
})
export class HouseholdLinkTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @Column({ type: 'uuid', unique: true })
  cloudLinkId!: string;

  @Column({ type: 'uuid' })
  peerInstanceId!: string;

  @Column({ type: 'text' })
  peerName!: string;

  /** What this server's administrator calls the other household. It never leaves this server. */
  @Column({ type: 'text' })
  householdName!: string;

  @Column({ type: 'text' })
  peerPublicKey!: string;

  @Column({ type: 'jsonb', default: '[]' })
  addresses!: Generated<HouseholdLinkAddress[]>;

  @Column({ type: 'text', default: 'active' })
  state!: Generated<string>;

  /** Why the link is paused, or why an active link cannot be reached: a short machine word. */
  @Column({ type: 'text', nullable: true })
  pausedReason!: string | null;

  /** The kind of address that last answered (`local`, `wan`, `ipv6`, `relay`). */
  @Column({ type: 'text', nullable: true })
  connectionPath!: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  lastSeenAt!: Timestamp | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  endedAt!: Timestamp | null;
}

/**
 * FL-952: every request proof admitted from a linked household, kept until its grant expires, so a
 * proof cannot be replayed after a restart or on another API worker.
 */
@Table('household_peer_request')
@Index({ name: 'household_peer_request_expiresAt_idx', columns: ['expiresAt'] })
export class HouseholdPeerRequestTable {
  @PrimaryColumn({ type: 'text' })
  jti!: string;

  @ForeignKeyColumn(() => HouseholdLinkTable, { onDelete: 'CASCADE', nullable: false })
  linkId!: string;

  @Column({ type: 'timestamp with time zone' })
  expiresAt!: Timestamp;
}
