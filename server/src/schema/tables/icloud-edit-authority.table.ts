import { Check, Column, ForeignKeyColumn, PrimaryColumn, Table, Unique } from '@frameleaf/sql-tools';
import { UserTable } from 'src/schema/tables/user.table.js';

/** Administrative owner authority is distinct from provider ordering and byte equivalence. */
@Table('icloud_edit_authority')
@Check({ name: 'icloud_edit_authority_generation_check', expression: 'generation > 0' })
export class ICloudEditAuthorityTable {
  @ForeignKeyColumn(() => UserTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE' }) ownerId!: string;
  @PrimaryColumn({ type: 'text' }) item!: string;
  @Column({ type: 'integer' }) generation!: number;
  @Column({ type: 'text' }) holder!: string;
  @Column({ type: 'uuid' }) sourceIncarnation!: string;
  @Column({ type: 'uuid' }) currentVersionId!: string;
  @Column({ type: 'uuid' }) baselineDecisionId!: string;
}
@Table('icloud_edit_version')
@Unique({ name: 'icloud_edit_version_asset_uq', columns: ['ownerId', 'item', 'assetId'] })
@Check({ name: 'icloud_edit_version_digest_check', expression: 'octet_length(sha256) = 32' })
export class ICloudEditVersionTable {
  @PrimaryColumn({ type: 'uuid' }) id!: string;
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) ownerId!: string;
  @Column({ type: 'text' }) item!: string;
  /** Historical evidence survives asset removal; removal never authorizes a fresh publication. */
  @Column({ type: 'uuid' }) assetId!: string;
  @Column({ type: 'bytea' }) sha256!: Buffer;
  @Column({ type: 'boolean' }) isOriginal!: boolean;
}
@Table('icloud_edit_alias')
export class ICloudEditAliasTable {
  @ForeignKeyColumn(() => UserTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE' }) ownerId!: string;
  @PrimaryColumn({ type: 'text' }) item!: string;
  @PrimaryColumn({ type: 'text' }) holder!: string;
  @PrimaryColumn({ type: 'uuid' }) sourceIncarnation!: string;
  @PrimaryColumn({ type: 'text' }) nativeVersion!: string;
  @ForeignKeyColumn(() => ICloudEditVersionTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) versionId!: string;
}
@Table('icloud_edit_decision')
@Unique({ name: 'icloud_edit_decision_resource_uq', columns: ['ownerId', 'channel', 'resourceId'] })
@Check({ name: 'icloud_edit_decision_kind_check', expression: `kind IN ('baseline','successor')` })
export class ICloudEditDecisionTable {
  @PrimaryColumn({ type: 'uuid' }) id!: string;
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) ownerId!: string;
  @Column({ type: 'text' }) item!: string;
  @Column({ type: 'text' }) kind!: 'baseline' | 'successor';
  @Column({ type: 'integer' }) generation!: number;
  @Column({ type: 'uuid' }) versionId!: string;
  @Column({ type: 'jsonb' }) evidence!: Record<string, unknown>;
  @Column({ type: 'text', nullable: true }) channel!: 'device' | 'icloud-sync' | null;
  @Column({ type: 'uuid', nullable: true }) resourceId!: string | null;
  @Column({ type: 'uuid', nullable: true }) assetId!: string | null;
  @Column({ type: 'jsonb' }) events!: unknown[];
}
