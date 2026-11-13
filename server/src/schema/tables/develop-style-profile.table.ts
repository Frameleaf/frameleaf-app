import { Column, ForeignKeyColumn, Table } from '@frameleaf/sql-tools';
import type { Timestamp } from '@frameleaf/sql-tools';
import { UserTable } from 'src/schema/tables/user.table.js';
import type { StyleModel } from 'src/utils/develop-style.js';

@Table('develop_style_profile')
export class DevelopStyleProfileTable {
  @ForeignKeyColumn(() => UserTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE' }) userId!: string;
  @Column({ type: 'integer' }) version!: number;
  @Column({ type: 'integer' }) sampleCount!: number;
  @Column({ type: 'jsonb' }) modelJson!: StyleModel & { producerModelKey: string | null };
  @Column({ type: 'timestamp with time zone' }) trainedAt!: Timestamp;
}
