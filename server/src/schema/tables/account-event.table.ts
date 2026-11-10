import { Column, CreateDateColumn, ForeignKeyColumn, Index, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { PrimaryGeneratedUuidV7Column } from 'src/decorators.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * FL-808 (E16-02): what happened to an account, as the account itself did it: sign-ins, sign-outs,
 * credential changes, API keys and shares. Mirrors migration 1794060000000-AccountEvent.
 *
 * Written by the service that made the change, read by the account owner (`GET /users/me/activity`)
 * and administrators (`GET /admin/activity`). A row holds names only, never a password, PIN, token,
 * API key secret or file path. Kept 400 days (nightly cleanup).
 */
@Index({ name: 'account_event_userId_createdAt_idx', columns: ['userId', 'createdAt'] })
@Table({ name: 'account_event' })
export class AccountEventTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false, index: false })
  userId!: string;

  /** The session it happened in; no foreign key, so the row outlives the session. */
  @Column({ type: 'uuid', nullable: true })
  sessionId!: string | null;

  /** `AccountEventAction`; plain text so new actions never need a migration. */
  @Column()
  action!: string;

  /** A name: a device, an API key, a partner, an album. */
  @Column()
  subject!: string;

  @Column({ nullable: true })
  detail!: string | null;

  /** The client address cut to its /24 (IPv4) or /48 (IPv6). */
  @Column({ nullable: true })
  ipPrefix!: string | null;

  @Column({ nullable: true })
  deviceType!: string | null;

  @Column({ nullable: true })
  deviceOS!: string | null;

  /** `home`, `direct` or `relay`; null when the request did not come through the edge worker. */
  @Column({ nullable: true })
  via!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
