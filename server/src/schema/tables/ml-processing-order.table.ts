import { Check, Column, PrimaryColumn, Table, UpdateDateColumn } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import type { MlProcessingSource } from 'src/enum.js';

/**
 * FL-456: the order processing tries its places in. The row with scope `default` is the one list every
 * workload follows; a row whose scope is a workload is that workload's own list. An empty list keeps the
 * workload off. Migration 2100000003008 seeds it from the routes saved before, so upgrades change nothing.
 */
@Table('ml_processing_order')
@Check({ name: 'ml_processing_order_sources_check', expression: `jsonb_typeof(sources) = 'array'` })
export class MlProcessingOrderTable {
  @PrimaryColumn({ type: 'text' })
  scope!: string;

  /** The places to try, first to last, as a JSON array of `MlProcessingSource` values. */
  @Column({ type: 'jsonb' })
  sources!: MlProcessingSource[];

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
