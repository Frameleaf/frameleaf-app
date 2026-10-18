import { Check, Column, ForeignKeyColumn, Index, Table, TriggerFunction } from '@frameleaf/sql-tools';
import type { Generated } from '@frameleaf/sql-tools';
import { desktop_clip_producer_guard } from 'src/schema/functions.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { DesktopClipProducerTable } from 'src/schema/tables/desktop-clip-index.table.js';

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
@TriggerFunction({
  name: 'smart_search_producer_guard',
  timing: 'before',
  actions: ['insert', 'update'],
  scope: 'row',
  function: desktop_clip_producer_guard,
})
export class SmartSearchTable {
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', primary: true })
  assetId!: string;

  @Column({ type: 'vector', length: 768, storage: 'external', synchronize: false })
  embedding!: string;

  // Null retains unknown legacy provenance; a model name or dimension cannot establish identity.
  @Column({ nullable: true })
  producerModelKey!: string | null;

  @ForeignKeyColumn(() => DesktopClipProducerTable, {
    type: 'text',
    default: 'legacy',
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  })
  producerAdmissionKey!: Generated<string>;
}
