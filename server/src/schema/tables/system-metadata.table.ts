import { Column, Index, PrimaryColumn, Table } from '@frameleaf/sql-tools';
import type { SystemMetadata } from 'src/types.js';
import { SystemMetadataKey } from 'src/enum.js';

@Table('system_metadata')
// FL-1213: queue maintenance sweeps keys by prefix (`starts_with`) every 30 seconds; the primary key's
// collation cannot answer a prefix, so without this each sweep reads every attempt-evidence row
@Index({ name: 'system_metadata_key_prefix_idx', expression: 'key text_pattern_ops' })
export class SystemMetadataTable<T extends keyof SystemMetadata = SystemMetadataKey> {
  @PrimaryColumn({ type: 'character varying' })
  key!: T;

  @Column({ type: 'jsonb' })
  value!: SystemMetadata[T];
}
