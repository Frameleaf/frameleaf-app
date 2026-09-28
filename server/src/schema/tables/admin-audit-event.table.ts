import { Column, CreateDateColumn, ForeignKeyColumn, Index, Table } from '@immich/sql-tools';
import type { Generated, Timestamp } from '@immich/sql-tools';
import { PrimaryGeneratedUuidV7Column } from 'src/decorators.js';
import { AdminAuditAction } from 'src/enum.js';
import { LibraryTable } from 'src/schema/tables/library.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * One thing an administrator did to an account or to one of its libraries (FL-76). Mirrors
 * migration 2100000000450-AddAdminAuditEvent.
 *
 * **Written by the change, read by administrators.** The service that makes the change writes the
 * row in the same request, after the change has succeeded. Only the account detail's Activity tab
 * reads it, through an admin-only endpoint. A row holds names and settings, never a photo, a path to
 * one or a secret: a password or PIN change is recorded as having happened, never with its value.
 *
 * `userId` is the account the event is about (a library event's owner) and cascades: when the
 * account is removed for good, its history goes with it. `actorId` and `libraryId` fall back to null
 * when the administrator's account or the library is gone; the row stays, and `subject` keeps the
 * name the account or library had at the time so the sentence still reads.
 */
@Index({ name: 'admin_audit_event_userId_createdAt_idx', columns: ['userId', 'createdAt'] })
@Table({ name: 'admin_audit_event' })
export class AdminAuditEventTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  /** The account this event is about; a library event's owner. */
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  userId!: string;

  /** The administrator who did it. Null once that account is gone. */
  @ForeignKeyColumn(() => UserTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  actorId!: string | null;

  /** The library a library event is about. Null for account events and once the library is gone. */
  @ForeignKeyColumn(() => LibraryTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  libraryId!: string | null;

  /** `AdminAuditAction`. */
  @Column()
  action!: AdminAuditAction;

  /** The account's or library's name at the time. */
  @Column()
  subject!: string;

  /** The specifics an action carries; see `AdminAuditAction`. Never a password, PIN or token. */
  @Column({ nullable: true })
  detail!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
