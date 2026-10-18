import { Check, Column, ForeignKeyColumn, PrimaryColumn, Table, UpdateDateColumn } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import type { MlWorkload } from 'src/enum.js';
import { MlDestinationTable } from 'src/schema/tables/ml-destination.table.js';

@Table('ml_workload_route_origin')
@Check({ name: 'ml_workload_route_origin_kind_check', expression: `origin IN ('default', 'pinned')` })
export class MlWorkloadRouteOriginTable {
  @PrimaryColumn({ type: 'text' }) workload!: MlWorkload;
  @Column({ type: 'text' }) origin!: 'default' | 'pinned';
  @Column({ type: 'uuid' }) revisionId!: string;
  @ForeignKeyColumn(() => MlDestinationTable, { nullable: true, onDelete: 'SET NULL', onUpdate: 'CASCADE' })
  destinationId!: string | null;
  @UpdateDateColumn() updatedAt!: Generated<Timestamp>;
}
