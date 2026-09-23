import { Check, Column, CreateDateColumn, ForeignKeyColumn, Table, Unique } from '@immich/sql-tools';
import type { Generated, Timestamp } from '@immich/sql-tools';
import { PrimaryGeneratedUuidV7Column } from 'src/decorators.js';
import { ClassificationMediaType, ClassificationRuleAction } from 'src/enum.js';
import { AlbumTable } from 'src/schema/tables/album.table.js';
import { TagTable } from 'src/schema/tables/tag.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * One classification rule (FL-60). Mirrors migration 2100000000610-AddClassificationRule.
 *
 * A rule always backs one album its owner owns: the smart album that shows what it matched. The rule
 * only ever reads and changes its owner's own media, so it never grants anybody access to anything;
 * sharing the album is the owner's separate, explicit choice. Archiving matches is stored only
 * together with the moment the owner consented to it (`classification_rule_archive_consent_chk`).
 */
@Unique({ name: 'classification_rule_albumId_uq', columns: ['albumId'] })
@Check({
  name: 'classification_rule_archive_consent_chk',
  expression: `NOT "archive" OR "archiveConsentAt" IS NOT NULL`,
})
@Table({ name: 'classification_rule' })
export class ClassificationRuleTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  ownerId!: string;

  /** The smart album that shows the rule's results. Deleting the album deletes the rule. */
  @ForeignKeyColumn(() => AlbumTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  albumId!: string;

  /** A disabled rule keeps what it applied and stops changing anything. */
  @Column({ type: 'boolean', default: true })
  enabled!: Generated<boolean>;

  /** Any of these people. */
  @Column({ type: 'jsonb', default: '[]' })
  personIds!: Generated<string[]>;

  /** Any of these tags, or a tag beneath one of them. */
  @Column({ type: 'jsonb', default: '[]' })
  tagIds!: Generated<string[]>;

  /** `YYYY-MM-DD`, inclusive. */
  @Column({ nullable: true })
  takenAfter!: string | null;

  /** `YYYY-MM-DD`, inclusive. */
  @Column({ nullable: true })
  takenBefore!: string | null;

  /** `ClassificationMediaType`. */
  @Column({ default: ClassificationMediaType.Any })
  mediaType!: Generated<ClassificationMediaType>;

  /** Visual category phrases, compared with each asset's visual search embedding. */
  @Column({ type: 'jsonb', default: '[]' })
  visualQueries!: Generated<string[]>;

  /** The confidence (cosine similarity) a visual phrase has to reach. */
  @Column({ type: 'double precision', default: 0.25 })
  threshold!: Generated<number>;

  /** `ClassificationRuleAction`. */
  @Column({ default: ClassificationRuleAction.Review })
  action!: Generated<ClassificationRuleAction>;

  /** The rule-owned tag a match receives. Null when the rule tags nothing. */
  @ForeignKeyColumn(() => TagTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  tagId!: string | null;

  /** Archive matches. Only ever true together with `archiveConsentAt`. */
  @Column({ type: 'boolean', default: false })
  archive!: Generated<boolean>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  archiveConsentAt!: Timestamp | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @Column({ type: 'timestamp with time zone', default: () => 'now()' })
  updatedAt!: Generated<Timestamp>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  lastAppliedAt!: Timestamp | null;
}
