import { Column, CreateDateColumn, PrimaryGeneratedColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';

@Table('version_history')
export class VersionHistoryTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @Column()
  version!: string;
}
