import { Check, Column, ForeignKeyColumn, PrimaryColumn, Table } from '@frameleaf/sql-tools';
import type { Generated } from '@frameleaf/sql-tools';
import type { DesktopClipSpace } from 'src/utils/desktop-clip-space.js';

@Table('desktop_clip_index')
@Check({ name: 'desktop_clip_index_scope_check', expression: `scope IN ('unadmitted', 'clip')` })
@Check({
  name: 'desktop_clip_index_space_check',
  expression: `(scope = 'unadmitted' AND space IS NULL) OR (scope = 'clip' AND space IS NOT NULL AND jsonb_typeof(space) = 'object')`,
})
export class DesktopClipIndexTable {
  @PrimaryColumn({ type: 'text' }) scope!: 'unadmitted' | 'clip';
  @Column({ type: 'uuid' }) revisionId!: string;
  @Column({ type: 'jsonb', nullable: true }) space!: DesktopClipSpace | null;
}

@Table('desktop_clip_producer')
@Check({
  name: 'desktop_clip_producer_key_check',
  expression: `key = 'legacy' OR key ~ '^(image|text):clip:[a-f0-9]{64}$'`,
})
export class DesktopClipProducerTable {
  @PrimaryColumn({ type: 'text' }) key!: string;
  @ForeignKeyColumn(() => DesktopClipIndexTable, {
    type: 'text',
    default: 'unadmitted',
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  })
  scope!: Generated<'unadmitted' | 'clip'>;
}
