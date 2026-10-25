import {
  Check,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Index,
  PrimaryGeneratedColumn,
  Table,
  Unique,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { DesktopDeviceTable } from 'src/schema/tables/desktop-device.table.js';
import { PhotoSourceResourceTable, PhotoSourceTable } from 'src/schema/tables/photo-source.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

@Table('source_original')
@Check({ name: 'source_original_epoch_check', expression: '"authorizationEpoch" > 0' })
@Unique({ columns: ['resourceId'] })
export class SourceOriginalTable {
  @ForeignKeyColumn(() => AssetTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  assetId!: string;
  @ForeignKeyColumn(() => PhotoSourceResourceTable, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    index: false,
  })
  resourceId!: string;
  @Column() scopeFingerprint!: string;
  @Column({ type: 'integer' }) authorizationEpoch!: number;
}

@Table('source_resource_read')
@Index({ columns: ['sourceId', 'state', 'createdAt'] })
@Index({
  name: 'source_resource_read_claimed_source_uq',
  columns: ['sourceId'],
  unique: true,
  where: `state IN ('claimed', 'delivering')`,
})
@Index({
  name: 'source_resource_read_active_uq',
  columns: ['assetId', 'resourceId', 'scopeFingerprint', 'authorizationEpoch'],
  unique: true,
  where: `state IN ('pending', 'claimed', 'delivering')`,
})
@Check({
  name: 'source_resource_read_state_check',
  expression: `state IN ('pending','claimed','delivering','ready','unavailable')`,
})
@Check({ name: 'source_resource_read_epoch_check', expression: '"authorizationEpoch" > 0 AND "claimFence" >= 0' })
@Check({
  name: 'source_resource_read_claim_check',
  expression: `("claimTokenHash" IS NULL OR octet_length("claimTokenHash") = 32)
    AND ("claimCredentialHash" IS NULL OR octet_length("claimCredentialHash") = 32)
    AND (state NOT IN ('claimed','delivering') OR
      ("claimFence" > 0 AND "claimTokenHash" IS NOT NULL AND "claimCredentialHash" IS NOT NULL AND "leaseUntil" IS NOT NULL))`,
})
export class SourceResourceReadTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) assetId!: string;
  @ForeignKeyColumn(() => PhotoSourceResourceTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) resourceId!: string;
  @ForeignKeyColumn(() => PhotoSourceTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  sourceId!: string;
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) ownerId!: string;
  @ForeignKeyColumn(() => DesktopDeviceTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) deviceId!: string;
  @Column() scopeFingerprint!: string;
  @Column({ type: 'integer' }) authorizationEpoch!: number;
  @Column({ default: 'pending' }) state!: Generated<'pending' | 'claimed' | 'delivering' | 'ready' | 'unavailable'>;
  @Column({ default: false }) consumerManaged!: Generated<boolean>;
  @Column({ type: 'integer', default: 0 }) claimFence!: Generated<number>;
  @Column({ type: 'bytea', nullable: true }) claimTokenHash!: Buffer | null;
  @Column({ type: 'bytea', nullable: true }) claimCredentialHash!: Buffer | null;
  @Column({ type: 'timestamp with time zone', nullable: true }) leaseUntil!: Timestamp | null;
  @Column({ type: 'timestamp with time zone' }) deadline!: Timestamp;
  @CreateDateColumn() createdAt!: Generated<Timestamp>;
}

/** Waiting interest only: releasing it never proves a cache reader or native writer stopped. */
@Table('source_resource_read_consumer')
@Unique({ columns: ['readId', 'readerId'] })
export class SourceResourceReadConsumerTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => SourceResourceReadTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) readId!: string;
  @Column({ type: 'uuid' }) readerId!: string;
  @Column({ type: 'uuid' }) readerOwnerId!: string;
  @Column({ type: 'timestamp with time zone', nullable: true }) expiresAt!: Timestamp | null;
}
