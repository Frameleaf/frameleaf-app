import { Check, Column, ForeignKeyColumn, Index, Table, TriggerFunction } from '@frameleaf/sql-tools';
import type { Generated } from '@frameleaf/sql-tools';
import { desktop_clip_producer_guard } from 'src/schema/functions.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { DesktopClipProducerTable } from 'src/schema/tables/desktop-clip-index.table.js';

// Sibling of smart_search that stores a CLIP-text embedding of an asset's
// description (manual or VLM-generated). Lets smart search retrieve via
// "what the description says about the image" alongside the visual embedding,
// recovering CLIP queries that miss because the visual encoder didn't capture
// the relevant concept but the description (or VLM) did.
@Table({ name: 'smart_search_description' })
@Index({
  name: 'clip_description_index',
  using: 'hnsw',
  expression: `embedding vector_cosine_ops`,
  with: `ef_construction = 300, m = 16`,
  synchronize: false,
})
@Check({
  name: 'smart_search_description_producer_key_check',
  expression: `"producerModelKey" IS NULL OR "producerModelKey" ~ '^clip:[a-f0-9]{64}$'`,
})
@TriggerFunction({
  name: 'smart_search_description_producer_guard',
  timing: 'before',
  actions: ['insert', 'update'],
  scope: 'row',
  function: desktop_clip_producer_guard,
})
export class SmartSearchDescriptionTable {
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', primary: true })
  assetId!: string;

  @Column({ type: 'vector', length: 768, storage: 'external', synchronize: false })
  embedding!: string;

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
