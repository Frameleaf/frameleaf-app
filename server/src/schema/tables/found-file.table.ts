import { Column, Index, Table, Unique } from '@frameleaf/sql-tools';
import type { Generated, Int8, Timestamp } from '@frameleaf/sql-tools';
import { PrimaryGeneratedUuidV7Column } from 'src/decorators.js';

/** What a file that was on the drive but in nobody's library turned out to be. */
export const FOUND_FILE_OUTCOMES = ['back', 'added', 'spare', 'needs'] as const;
export type FoundFileOutcome = (typeof FOUND_FILE_OUTCOMES)[number];

/** Why a found file waits for a person. Text, not an enum: new reasons are added without a schema change. */
export type FoundFileReason = 'no-owner' | 'wont-open' | 'over-limit';

/** One thing Frameleaf did with a found file, oldest first. */
export type FoundFileStep = { step: string; at: string; outcome?: string; facts?: Record<string, unknown> };

/**
 * FL-1532: a file the stray-file check found on the drive that no library lists, read once. The row
 * remembers the file's contents (its digests, for the size and modified time it had when it was read), so
 * the drive is never read again for the same answer, and what Frameleaf did with it.
 *
 * `ownerId` and `assetId` are plain ids, not foreign keys: the row is the file's history and outlives
 * the photo and the account. Mirrors migration 1794560000000-FoundFile.
 */
@Table('found_file')
@Unique({ name: 'found_file_path_uq', columns: ['path'] })
@Index({ name: 'found_file_outcome_idx', columns: ['outcome', 'sortedAt', 'id'] })
@Index({ name: 'found_file_owner_idx', columns: ['ownerId', 'outcome'] })
export class FoundFileTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @Column({ type: 'text' })
  path!: string;

  /** The file's size and modified time when it was read: the digests speak for that file only. */
  @Column({ type: 'bigint' })
  sizeInBytes!: Int8;

  @Column({ type: 'timestamp with time zone' })
  modifiedAt!: Timestamp;

  /** Null for a file that could not be read. */
  @Column({ type: 'bytea', nullable: true })
  sha1!: Buffer | null;

  @Column({ type: 'bytea', nullable: true })
  sha256!: Buffer | null;

  @Column({ type: 'text' })
  outcome!: FoundFileOutcome;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  /** The account whose folder the file is in; null for a folder no account owns. */
  @Column({ type: 'uuid', nullable: true })
  ownerId!: string | null;

  /** The photo it went back under, became, or copies. */
  @Column({ type: 'uuid', nullable: true })
  assetId!: string | null;

  /** Where the photo's record pointed before the file went back under it, for Undo. */
  @Column({ type: 'text', nullable: true })
  previousPath!: string | null;

  @Column({ type: 'jsonb', default: '[]' })
  steps!: Generated<FoundFileStep[]>;

  @Column({ type: 'timestamp with time zone', default: () => 'now()' })
  sortedAt!: Generated<Timestamp>;
}
