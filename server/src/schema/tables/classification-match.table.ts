import { Column, CreateDateColumn, ForeignKeyColumn, Index, Table } from '@immich/sql-tools';
import type { Generated, Timestamp } from '@immich/sql-tools';
import { ClassificationMatchDecision } from 'src/enum.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { ClassificationRuleTable } from 'src/schema/tables/classification-rule.table.js';

/**
 * One asset a classification rule matched and what became of it (FL-60). Mirrors migration
 * 2100000000610-AddClassificationRule.
 *
 * `accepted` and `rejected` are the owner's own decisions and survive every reprocessing.
 * `tagContributed` / `archiveContributed` say this rule added the tag or archived the asset itself;
 * undoing a match only reverses what the rule contributed and only when no other rule still holds it.
 */
@Index({ columns: ['ruleId', 'decision'] })
@Table({ name: 'classification_match' })
export class ClassificationMatchTable {
  @ForeignKeyColumn(() => ClassificationRuleTable, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: false,
    primary: true,
  })
  ruleId!: string;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false, primary: true })
  assetId!: string;

  /** The best visual similarity when the rule has visual phrases. */
  @Column({ type: 'double precision', nullable: true })
  score!: number | null;

  /** `ClassificationMatchDecision`. */
  @Column()
  decision!: ClassificationMatchDecision;

  @Column({ type: 'boolean', default: false })
  tagContributed!: Generated<boolean>;

  @Column({ type: 'boolean', default: false })
  archiveContributed!: Generated<boolean>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @Column({ type: 'timestamp with time zone', default: () => 'now()' })
  updatedAt!: Generated<Timestamp>;
}
