import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Index,
  PrimaryGeneratedColumn,
  Table,
  Unique,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import type { Int8Writable } from 'src/schema/int8-writable.js';
import { DesktopDeviceTable } from 'src/schema/tables/desktop-device.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

@Table('photo_source')
@Index({ columns: ['ownerId'] })
@Index({ columns: ['deviceId'] })
export class PhotoSourceTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) ownerId!: string;
  @ForeignKeyColumn(() => DesktopDeviceTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) deviceId!: string;
  // Keep provenance after logout; a fresh photo session must explicitly rebind the grant.
  @Column({ type: 'uuid' }) photoSessionId!: string;
  @Column() kind!: 'folder' | 'apple-photos';
  @Column() mode!: 'copy' | 'reference';
  @Column() name!: string;
  @Column() scopeFingerprint!: string;
  @Column({ type: 'timestamp with time zone', nullable: true }) revokedAt!: Timestamp | null;
  @CreateDateColumn() createdAt!: Generated<Timestamp>;
}
@Table('photo_source_run')
@Index({ columns: ['sourceId'] })
export class PhotoSourceRunTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => PhotoSourceTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) sourceId!: string;
  @Column({ type: 'bigint' }) maxBytes!: Int8Writable;
  @Column({ type: 'integer' }) maxItems!: number;
  @Column({ default: 'open' }) state!: Generated<'open' | 'paused' | 'cancelled' | 'complete'>;
  @Column({ type: 'boolean', default: false }) inventoryComplete!: Generated<boolean>;
  @CreateDateColumn() createdAt!: Generated<Timestamp>;
}
@Table('photo_source_resource')
@Unique({ columns: ['runId', 'resourceKey', 'version'] })
export class PhotoSourceResourceTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => PhotoSourceRunTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) runId!: string;
  @Column() resourceKey!: string;
  @Column() version!: string;
  @Column({ type: 'bytea' }) checksum!: Buffer;
  @Column({ type: 'bigint' }) bytes!: Int8Writable;
  @Column({ default: 'planned' }) state!: Generated<'planned' | 'verified'>;
  // Source associations survive asset deletion; absence is never permission to recreate it.
  @Column({ type: 'uuid', nullable: true }) assetId!: string | null;
  @Column({ type: 'uuid', nullable: true }) uploadResourceId!: string | null;
  @Column({ type: 'timestamp with time zone', nullable: true }) verifiedAt!: Timestamp | null;
  @CreateDateColumn() createdAt!: Generated<Timestamp>;
}
