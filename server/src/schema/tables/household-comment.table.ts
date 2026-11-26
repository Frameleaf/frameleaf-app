import {
  Check,
  Column,
  ForeignKeyColumn,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  Table,
  Unique,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { ActivityTable } from 'src/schema/tables/activity.table.js';
import { HouseholdLinkTable } from 'src/schema/tables/household-link.table.js';
import { HouseholdInboundShareTable } from 'src/schema/tables/household-receive.table.js';

/**
 * FL-1012: a person on another household's server who wrote a comment or a like here. Never a local account: it
 * cannot sign in, own anything or be mentioned. The id is a v4 uuid because activity responses report it as `user.id`.
 * `avatarPath` stays null in version 1: remote authors are shown by name.
 */
@Table('household_remote_author')
@Unique({ columns: ['linkId', 'remoteUserId'] })
export class HouseholdRemoteAuthorTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => HouseholdLinkTable, { onDelete: 'CASCADE', nullable: false, index: false })
  linkId!: string;

  @Column({ type: 'uuid' })
  remoteUserId!: string;

  @Column({ type: 'text' })
  displayName!: string;

  @Column({ type: 'text', nullable: true })
  avatarPath!: string | null;
}

/**
 * FL-1012, the receiving side: which local `activity` row stands for which comment of the sender, per inbound share.
 * `own` rows were written here and are sent to the sender (`pending`), under the local id, so the comment is known
 * when it comes back through the manifest. A row whose `activityId` is null was removed here and is not recreated.
 */
@Table('household_comment')
@Index({
  name: 'household_comment_pending_idx',
  columns: ['inboundShareId', 'nextAttemptAt'],
  where: '(pending IS NOT NULL)',
})
@Check({
  name: 'household_comment_pending_check',
  expression: `pending = ANY (ARRAY['post'::text, 'put'::text, 'delete'::text])`,
})
export class HouseholdCommentTable {
  @ForeignKeyColumn(() => HouseholdInboundShareTable, {
    onDelete: 'CASCADE',
    nullable: false,
    primary: true,
    index: false,
  })
  inboundShareId!: string;

  @PrimaryColumn({ type: 'uuid' })
  remoteId!: string;

  @ForeignKeyColumn(() => ActivityTable, { onDelete: 'SET NULL', nullable: true })
  activityId!: string | null;

  @Column({ type: 'boolean', default: false })
  own!: Generated<boolean>;

  @Column({ type: 'text', nullable: true })
  pending!: string | null;

  /** Moves on each local change, so a reply to an older send cannot clear a newer one. */
  @Column({ type: 'integer', default: 0 })
  revision!: Generated<number>;

  @Column({ type: 'integer', default: 0 })
  attempts!: Generated<number>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  nextAttemptAt!: Timestamp | null;
}
