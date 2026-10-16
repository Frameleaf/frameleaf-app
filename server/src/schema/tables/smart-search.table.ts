import { Check, Column, ForeignKeyColumn, Index, Table } from '@frameleaf/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';

@Table({ name: 'smart_search' })
@Index({
  name: 'clip_index',
  using: 'hnsw',
  expression: `embedding vector_cosine_ops`,
  with: `ef_construction = 300, m = 16`,
  synchronize: false,
})
@Check({
  name: 'smart_search_producer_key_check',
  expression: `"producerModelKey" IS NULL OR "producerModelKey" ~ '^clip:[a-f0-9]{64}$'`,
})
export class SmartSearchTable {
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', primary: true })
  assetId!: string;

  @Column({ type: 'vector', length: 768, storage: 'external', synchronize: false })
  embedding!: string;

  // Null retains unknown legacy provenance; a model name or dimension cannot establish identity.
  @Column({ nullable: true })
  producerModelKey!: string | null;
}
