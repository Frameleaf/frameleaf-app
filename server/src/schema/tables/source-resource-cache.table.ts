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
import type { Int8Writable } from 'src/schema/int8-writable.js';

@Table('source_resource_cache')
@Unique({ columns: ['readId', 'claimFence'] })
@Index({ columns: ['state', 'createdAt'] })
@Check({ name: 'source_resource_cache_state_check', expression: "state IN ('writing','ready','deleting')" })
@Check({
  name: 'source_resource_cache_size_check',
  expression: 'bytes > 0 AND bytes <= 9007199254740991 AND "claimFence" > 0 AND "authorizationEpoch" > 0',
})
@Check({
  name: 'source_resource_cache_digest_check',
  expression: `octet_length(sha256)=32 AND version ~ '^[a-f0-9]{64}$' AND "resourceKey" ~ '^[a-f0-9]{64}$' AND "scopeFingerprint" ~ '^[a-f0-9]{64}$'`,
})
@Check({
  name: 'source_resource_cache_file_check',
  expression: `("fileName" IS NULL OR "fileName" ~ '^[a-f0-9-]{36}[.]artifact$') AND (state <> 'ready' OR ("fileName" IS NOT NULL AND "writerStoppedAt" IS NOT NULL))`,
})
export class SourceResourceCacheTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  // Independent provenance: deleting an asset must not erase an active reader's cleanup ownership.
  @Column({ type: 'uuid' }) readId!: string;
  @Column({ type: 'integer' }) claimFence!: number;
  @Column({ type: 'uuid' }) assetId!: string;
  @Column({ type: 'uuid' }) resourceId!: string;
  @Column({ type: 'uuid' }) sourceId!: string;
  @Column({ type: 'uuid' }) ownerId!: string;
  @Column({ type: 'uuid' }) deviceId!: string;
  @Column() scopeFingerprint!: string;
  @Column({ type: 'integer' }) authorizationEpoch!: number;
  @Column() resourceKey!: string;
  @Column() version!: string;
  @Column({ type: 'bytea' }) sha256!: Buffer;
  @Column({ type: 'bigint' }) bytes!: Int8Writable;
  @Column({ default: 'writing' }) state!: Generated<'writing' | 'ready' | 'deleting'>;
  @Column({ default: false }) restoreHeld!: Generated<boolean>;
  @Column({ type: 'uuid' }) writerId!: string;
  @Column({ type: 'uuid' }) writerOwnerId!: string;
  @Column({ type: 'timestamp with time zone', nullable: true }) writerStoppedAt!: Timestamp | null;
  @Column({ nullable: true }) fileName!: string | null;
  @CreateDateColumn() createdAt!: Generated<Timestamp>;
}

@Table('source_resource_cache_lease')
@Unique({ columns: ['cacheId', 'readerId'] })
@Index({ columns: ['cacheId'] })
@Check({
  name: 'source_resource_cache_lease_kind_check',
  expression: `(kind='http' AND "jobId" IS NULL AND "attemptToken" IS NULL) OR (kind='job' AND "jobId" IS NOT NULL AND "attemptToken" IS NOT NULL)`,
})
export class SourceResourceCacheLeaseTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => SourceResourceCacheTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  cacheId!: string;
  @Column({ type: 'uuid' }) readerId!: string;
  @Column({ type: 'uuid' }) readerOwnerId!: string;
  @Column() kind!: 'http' | 'job';
  @Column({ type: 'uuid', nullable: true }) jobId!: string | null;
  @Column({ type: 'uuid', nullable: true }) attemptToken!: string | null;
  @Column({ type: 'timestamp with time zone', nullable: true }) readerStoppedAt!: Timestamp | null;
  @CreateDateColumn() createdAt!: Generated<Timestamp>;
}
