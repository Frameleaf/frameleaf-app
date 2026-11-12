import { Column, CreateDateColumn, ForeignKeyColumn, Index, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { PrimaryGeneratedUuidV7Column } from 'src/decorators.js';
import { MediaOperationTable } from 'src/schema/tables/media-operation.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * FL-938: one change Frameleaf Assistant proposed to a person's library, and what became of it.
 * Mirrors migration 1794485000000-AssistantAction.
 *
 * A row starts as `proposed` and changes nothing. Only its owner's confirming request makes it
 * `applied`; `before` then holds what each item was, so the same person can undo it for 30 days
 * (`undone`). A proposal nobody confirmed, and an applied change past its undo window, end as
 * `expired`. `status` and `kind` are plain text so a new one never needs a migration.
 *
 * Only the owner ever reads a row. It holds ids, names and the question as typed; never a file path.
 */
@Index({ name: 'assistant_action_userId_createdAt_idx', columns: ['userId', 'createdAt'] })
@Table({ name: 'assistant_action' })
export class AssistantActionTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false, index: false })
  userId!: string;

  /** The question the change came from, as the person typed it. */
  @Column({ type: 'text', nullable: true })
  question!: string | null;

  /** The write tool: `create_album`, `add_to_album`, `tag`, `favourite` or `cull`. */
  @Column()
  kind!: string;

  /** `proposed`, `applied`, `undone` or `expired`. */
  @Column()
  status!: string;

  /** What will change: the frozen items and the album or tags they go to. */
  @Column({ type: 'jsonb' })
  plan!: Record<string, unknown>;

  /** The durable bulk job that applied the change. */
  @ForeignKeyColumn(() => MediaOperationTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  mediaOperationId!: string | null;

  /** The album a `create_album` change made, so undo can take it away again. */
  @Column({ type: 'uuid', nullable: true })
  createdAlbumId!: string | null;

  /** What each item was before the change, written when it is applied. */
  @Column({ type: 'jsonb', nullable: true })
  before!: Record<string, unknown> | null;

  /** What undo restored and what it left alone, written when the change is undone. */
  @Column({ type: 'jsonb', nullable: true })
  undo!: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  appliedAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  undoneAt!: Timestamp | null;
}
