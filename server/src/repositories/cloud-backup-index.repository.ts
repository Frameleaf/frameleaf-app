import { Injectable } from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import type { SystemMetadata } from 'src/types.js';
import type { OwnerBackupState } from 'src/utils/cloud-backup-owner.js';
import type {
  CloudBackupAlbum,
  CloudBackupAssetDetails,
  CloudBackupAssetRecord,
  CloudBackupPerson,
} from 'src/utils/cloud-backup.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { defaults } from 'src/dtos/config.dto.js';
import { AssetFileType, AssetStatus, MediaOperationKind, MediaOperationStatus, SystemMetadataKey } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { CloudBackupVerificationMethod, CloudBackupVerificationResult } from 'src/schema/tables/safety-proof.table.js';
import { bucketRef } from 'src/utils/cloud-backup.js';
import { isMotionOfLockedStill, withHiddenContentFilter } from 'src/utils/database.js';
import { effectiveVisibilityOf, isLocked, isNotLocked } from 'src/utils/locked.js';

export type CloudBackupIndexedObject = {
  sha256: string;
  size: number;
  etag: string | null;
};
export type CloudBackupManifestRow = {
  id: string;
  bucket: string;
  key: string;
  operationId: string | null;
  status: string;
  createdAt: Date;
};
export type CloudBackupEntry = {
  fileKey: string;
  assetId: string | null;
  ownerId: string | null;
  role: string;
  path: string;
  sha256: string;
  size: number;
  mtime: Date | null;
};
/** One asset a run backs up: its original with the checksum on record, and its other files by type. */
export type CloudBackupAsset = {
  id: string;
  ownerId: string;
  originalPath: string;
  /** Lowercase hex SHA-256 from `public.asset_checksum`, or null when none is recorded. */
  sha256: string | null;
  checksumSize: number | null;
  verifiedAt: Date | null;
  /** The checksum was verified at this very path (`verifiedPaths` holds the original's path). */
  checksumPathVerified: boolean;
  files: Array<{
    type: AssetFileType;
    path: string;
  }>;
};
const MANIFEST_COLUMNS = ['id', 'bucket', 'key', 'operationId', 'status', 'createdAt'] as const;
const ENTRY_COLUMNS = ['fileKey', 'assetId', 'ownerId', 'role', 'path', 'sha256', 'size', 'mtime'] as const;
/** FL-164: manifests that are in the bucket and kept: complete ones, and ones a verification marked degraded. */
const KEPT_MANIFEST_STATUSES = ['complete', 'degraded'] as const;
/** FL-164: an asset a manifest names, as the library holds it now. */
export type CloudBackupLibraryAsset = {
  status: 'active' | 'trashed';
  originalFileName: string;
  originalPath: string;
  ownerId: string;
  isExternal: boolean;
  /** Locked (an `asset_lock` record): its name is never shown in a restore list. */
  locked: boolean;
};
/** FL-164: a manifest found in the bucket, as recorded when this server had no record of it. */
export type CloudBackupAdoptedManifest = {
  key: string;
  createdAt: Date;
  databaseKey: string | null;
  assetCount: number;
  fileCount: number;
  bytes: number;
};
/** FL-164: a kept manifest as the restore picker and retention read it. */
export type CloudBackupKeptManifest = {
  key: string;
  status: 'complete' | 'degraded';
  databaseKey: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  assetCount: number;
  fileCount: number;
  bytes: number;
};
const FINISHED_OPERATIONS = [
  MediaOperationStatus.Completed,
  MediaOperationStatus.Cancelled,
  MediaOperationStatus.Failed,
];
/**
 * Cloud backup's own tables (FL-160): the index of objects already in a claimed bucket, the run
 * manifests and the files a running manifest has recorded; and the reads a run makes over the library.
 *
 * The library reads are backend work and see every asset, Locked ones included: a backup must reach
 * Locked media (owner decision, September 22, 2026). Nothing read here is shown to anybody; the files go
 * to the claimed bucket, encrypted with its key.
 */
@Injectable()
export class CloudBackupIndexRepository {
  /** One statement keeps current owner/access/hash eligibility and backup facts in the same snapshot. */
  private safetyQuery(assets: ReturnType<IntegrityRepository['getSafetyQuery']>, bucket: string | null) {
    return sql<{
      id: string;
      sha256: string | null;
      deliveredBy: string | null;
      onServerSince: Date;
      isOffline: boolean;
      lastIntegrityAt: Date | null;
      integrityResult: 'passed' | 'mismatched' | 'missing' | 'unreadable' | null;
      backedUpSince: Date | null;
      lastCompletedAt: Date | null;
      lastVerifiedAt: Date | null;
    }>`SELECT assets.*, delivery."deliveredBy", backup."backedUpSince", backup."lastCompletedAt", verification."lastVerifiedAt"
      FROM (${assets}) assets
      LEFT JOIN LATERAL (
        SELECT identity."deliveredBy"
        FROM public.icloud_source_identity identity
        JOIN public.asset original ON original.id = identity."assetId" AND original."ownerId" = identity."ownerId"
        WHERE identity."assetId" = assets.id AND identity.sha256 = decode(assets.sha256, 'hex')
        ORDER BY identity."deliveredAt", identity.id LIMIT 1
      ) delivery ON true
      LEFT JOIN LATERAL (
        SELECT min(m."finishedAt") AS "backedUpSince", max(m."finishedAt") AS "lastCompletedAt"
        FROM cloud_backup_manifest_original membership
        JOIN cloud_backup_manifest m ON m.id = membership."manifestId"
        JOIN cloud_backup_object object ON object.bucket = m.bucket AND object.sha256 = membership.sha256
        JOIN media_operation operation ON operation.id = m."operationId"
        WHERE membership."assetId" = assets.id AND membership.sha256 = assets.sha256
          AND m.bucket = ${bucket} AND m.status = 'complete' AND m."finishedAt" IS NOT NULL
          AND operation.kind = 'cloud_backup' AND operation.status = 'completed'
          AND operation."finishedAt" IS NOT NULL
          AND operation.result ->> 'phase' = 'done'
          AND operation.snapshot ->> 'bucketRef' = m.bucket
      ) backup ON true
      LEFT JOIN LATERAL (
        SELECT CASE WHEN proof.result = 'passed' THEN operation."finishedAt" END AS "lastVerifiedAt"
        FROM cloud_backup_object_verification proof
        JOIN cloud_backup_object object ON object.bucket = proof.bucket AND object.sha256 = proof.sha256
        JOIN media_operation operation ON operation.id = proof."operationId"
        WHERE backup."backedUpSince" IS NOT NULL AND proof.bucket = ${bucket} AND proof.sha256 = assets.sha256
          AND proof.method = 'sha256-get' AND proof."checkedAt" >= object."uploadedAt"
          AND operation.kind = 'cloud_backup' AND operation.status = 'completed'
          AND operation."finishedAt" IS NOT NULL AND operation.snapshot ->> 'bucketRef' = proof.bucket
          AND operation.snapshot ->> 'task' = 'verify' AND operation.result ->> 'task' = 'verify'
          AND operation.result ->> 'done' = 'true'
          AND COALESCE(operation.snapshot ->> 'depth', 'sample') = 'sample'
          AND operation.result ->> 'depth' = 'sample'
        ORDER BY proof."checkedAt" DESC LIMIT 1
      ) verification ON true`;
  }
  async getSafetyAssets(assets: ReturnType<IntegrityRepository['getSafetyQuery']>, bucket: string | null) {
    return (await this.safetyQuery(assets, bucket).execute(this.db)).rows;
  }
  async getSafetySummary(assets: ReturnType<IntegrityRepository['getSafetyQuery']>, bucket: string | null) {
    const { rows } = await sql<{
      total: number;
      onServer: number;
      fromICloudSync: number;
      backedUp: number;
      lastCompletedAt: Date | null;
      lastVerifiedAt: Date | null;
    }>`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE NOT "isOffline" AND "integrityResult" IS DISTINCT FROM 'missing')::int AS "onServer",
      count(*) FILTER (WHERE "deliveredBy" LIKE 'icloud-sync:%')::int AS "fromICloudSync",
      count(*) FILTER (WHERE "backedUpSince" IS NOT NULL)::int AS "backedUp",
      max("lastCompletedAt") AS "lastCompletedAt", max("lastVerifiedAt") AS "lastVerifiedAt"
      FROM (${this.safetyQuery(assets, bucket)}) safety`.execute(this.db);
    return rows[0];
  }
  constructor(
    @InjectKysely()
    private db: Kysely<DB>,
  ) {}
  /** The hashes of these that are already in the bucket. */
  @GenerateSql({ params: [DummyValue.STRING, [DummyValue.STRING]] })
  async getExisting(bucket: string, hashes: string[]): Promise<Set<string>> {
    if (hashes.length === 0) {
      return new Set();
    }
    const rows = await this.db
      .selectFrom('cloud_backup_object')
      .select('sha256')
      .where('bucket', '=', bucket)
      .where('sha256', 'in', [...new Set(hashes)])
      .execute();
    return new Set(rows.map(({ sha256 }) => sha256));
  }
  /** Record objects that are in the bucket (uploaded, or found by the listing). Recording twice is harmless. */
  @GenerateSql({
    params: [DummyValue.STRING, [{ sha256: DummyValue.STRING, size: DummyValue.NUMBER, etag: DummyValue.STRING }]],
  })
  async record(bucket: string, objects: CloudBackupIndexedObject[]): Promise<void> {
    if (objects.length === 0) {
      return;
    }
    const unique = new Map(objects.map((object) => [object.sha256, object])).values().toArray();
    await this.db
      .insertInto('cloud_backup_object')
      .values(unique.map(({ sha256, size, etag }) => ({ bucket, sha256, size, etag })))
      .onConflict((oc) =>
        oc.columns(['bucket', 'sha256']).doUpdateSet((eb) => ({
          size: eb.ref('excluded.size'),
          etag: sql<string | null>`coalesce(excluded."etag", "cloud_backup_object"."etag")`,
          lastSeenAt: sql<Date>`now()`,
        })),
      )
      .execute();
  }
  /** Mark objects as referenced by the run in hand. */
  @GenerateSql({ params: [DummyValue.STRING, [DummyValue.STRING]] })
  async touch(bucket: string, hashes: string[]): Promise<void> {
    if (hashes.length === 0) {
      return;
    }
    await this.db
      .updateTable('cloud_backup_object')
      .set({ lastSeenAt: sql<Date>`now()` })
      .where('bucket', '=', bucket)
      .where('sha256', 'in', [...new Set(hashes)])
      .execute();
  }
  /** Forget everything recorded for a bucket: a new claim starts from the bucket as it is now. */
  @GenerateSql({ params: [DummyValue.STRING] })
  async deleteBucket(bucket: string): Promise<void> {
    await this.db.deleteFrom('cloud_backup_object').where('bucket', '=', bucket).execute();
  }
  /**
   * The database's clock, which stamps `lastSeenAt`, as ISO 8601 text with its microseconds. A `Date`
   * keeps only milliseconds, so a row stamped earlier in the same millisecond would not compare as
   * before it and would survive `pruneUnseen`.
   */
  @GenerateSql()
  async currentTime(): Promise<string> {
    const row = await this.db.selectNoFrom(sql<string>`to_json(now())`.as('now')).executeTakeFirstOrThrow();
    return row.now;
  }
  /** Forget objects the bucket listing no longer holds: every row the listing did not touch since `since`. */
  @GenerateSql({ params: [DummyValue.STRING, DummyValue.DATE] })
  async pruneUnseen(bucket: string, since: string): Promise<number> {
    const result = await this.db
      .deleteFrom('cloud_backup_object')
      .where('bucket', '=', bucket)
      .where('lastSeenAt', '<', sql<Date>`${since}::timestamptz`)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
  /** How many unique files the bucket holds for this server, and their size. */
  @GenerateSql({ params: [DummyValue.STRING] })
  async getUsage(bucket: string): Promise<{
    objects: number;
    bytes: number;
  }> {
    const row = await this.db
      .selectFrom('cloud_backup_object')
      .select((eb) => [eb.fn.countAll<string>().as('objects'), sql<string>`coalesce(sum("size"), 0)`.as('bytes')])
      .where('bucket', '=', bucket)
      .executeTakeFirst();
    return { objects: Number(row?.objects ?? 0), bytes: Number(row?.bytes ?? 0) };
  }
  @GenerateSql({ params: [{ bucket: DummyValue.STRING, key: DummyValue.STRING, operationId: DummyValue.UUID }] })
  async createManifest(values: { bucket: string; key: string; operationId: string }): Promise<CloudBackupManifestRow> {
    return this.db
      .insertInto('cloud_backup_manifest')
      .values(values)
      .returning(MANIFEST_COLUMNS)
      .executeTakeFirstOrThrow() as Promise<CloudBackupManifestRow>;
  }
  @GenerateSql({ params: [DummyValue.UUID] })
  async getManifest(id: string): Promise<CloudBackupManifestRow | undefined> {
    return this.db
      .selectFrom('cloud_backup_manifest')
      .select(MANIFEST_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst() as Promise<CloudBackupManifestRow | undefined>;
  }
  @GenerateSql({
    params: [
      DummyValue.UUID,
      { status: 'complete', assetCount: DummyValue.NUMBER, fileCount: DummyValue.NUMBER, bytes: DummyValue.NUMBER },
    ],
  })
  async finishManifest(
    id: string,
    values: {
      status: 'complete' | 'cancelled' | 'failed';
      assetCount?: number;
      fileCount?: number;
      bytes?: number;
    },
  ): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      const manifest = await tx
        .selectFrom('cloud_backup_manifest')
        .select('status')
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      // Completing twice cannot replace durable membership with later checkpoint rows.
      if (!manifest || manifest.status !== 'running') {
        return;
      }
      if (values.status === 'complete') {
        await tx
          .insertInto('cloud_backup_manifest_original')
          .columns(['manifestId', 'assetId', 'sha256'])
          .expression(
            tx
              .selectFrom('cloud_backup_manifest_entry')
              .select(['manifestId', sql<string>`"assetId"`.as('assetId'), 'sha256'])
              .where('manifestId', '=', id)
              .where('role', '=', 'original')
              .where('assetId', 'is not', null),
          )
          .onConflict((oc) => oc.columns(['manifestId', 'assetId']).doNothing())
          .execute();
      }
      await tx
        .updateTable('cloud_backup_manifest')
        .set({ ...values, finishedAt: sql<Date>`now()` })
        .where('id', '=', id)
        .execute();
    });
  }
  /** Persist the actual check under its current worker claim, never as a completed-run assertion. */
  @GenerateSql({
    params: [
      {
        bucket: DummyValue.STRING,
        sha256: DummyValue.STRING,
        operationId: DummyValue.UUID,
        claimToken: DummyValue.UUID_1,
        method: 'sha256-get',
        result: 'passed',
      },
    ],
  })
  async recordObjectVerification(input: {
    bucket: string;
    sha256: string;
    operationId: string;
    claimToken: string;
    method: CloudBackupVerificationMethod;
    result: CloudBackupVerificationResult;
  }): Promise<void> {
    const { claimToken, ...proof } = input;
    await this.db
      .insertInto('cloud_backup_object_verification')
      .columns(['bucket', 'sha256', 'operationId', 'method', 'result'])
      .expression(
        this.db
          .selectFrom('media_operation')
          .select([
            sql<string>`${proof.bucket}`.as('bucket'),
            sql<string>`${proof.sha256}`.as('sha256'),
            'id as operationId',
            sql<CloudBackupVerificationMethod>`${proof.method}`.as('method'),
            sql<CloudBackupVerificationResult>`${proof.result}`.as('result'),
          ])
          .where('id', '=', proof.operationId)
          .where('claimToken', '=', claimToken)
          .where('kind', '=', MediaOperationKind.CloudBackup)
          .where('status', 'not in', FINISHED_OPERATIONS)
          .where(sql<string>`snapshot ->> 'bucketRef'`, '=', proof.bucket)
          .where(sql<string>`snapshot ->> 'task'`, '=', 'verify')
          .where(
            sql<string>`COALESCE(snapshot ->> 'depth', 'sample')`,
            '=',
            proof.method === 'size-head' ? 'full' : 'sample',
          )
          .forShare(),
      )
      .onConflict((oc) =>
        oc
          .columns(['bucket', 'sha256', 'operationId'])
          .doUpdateSet({ method: proof.method, result: proof.result, checkedAt: sql<Date>`clock_timestamp()` }),
      )
      .execute();
  }
  /** Internal facts only: completion qualifies the run, not current asset access or backup eligibility. */
  @GenerateSql({ params: [DummyValue.STRING, [DummyValue.STRING]] })
  getCompletedObjectVerifications(bucket: string, hashes: string[]) {
    return this.db
      .selectFrom('cloud_backup_object_verification as proof')
      .innerJoin('media_operation as operation', 'operation.id', 'proof.operationId')
      .selectAll('proof')
      .where('proof.bucket', '=', bucket)
      .where('proof.sha256', 'in', hashes)
      .where('operation.kind', '=', MediaOperationKind.CloudBackup)
      .where('operation.status', '=', MediaOperationStatus.Completed)
      .where(sql<string>`operation.snapshot ->> 'bucketRef'`, '=', bucket)
      .where(sql<string>`operation.snapshot ->> 'task'`, '=', 'verify')
      .where(sql<string>`operation.result ->> 'task'`, '=', 'verify')
      .where(sql<string>`operation.result ->> 'done'`, '=', 'true')
      .where(
        sql<string>`operation.result ->> 'depth'`,
        '=',
        sql<string>`COALESCE(operation.snapshot ->> 'depth', 'sample')`,
      )
      .where(
        sql<boolean>`proof.method = CASE WHEN operation.snapshot ->> 'depth' = 'full' THEN 'size-head' ELSE 'sha256-get' END`,
      )
      .orderBy('proof.checkedAt', 'desc')
      .execute();
  }
  /** The database dump a manifest names, so no complete manifest ever loses its dump to pruning. */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  async setManifestDatabase(id: string, databaseKey: string): Promise<void> {
    await this.db.updateTable('cloud_backup_manifest').set({ databaseKey }).where('id', '=', id).execute();
  }
  /**
   * FL-164: the database dumps named by this bucket's manifests that are still kept (complete, or complete
   * and degraded by a verification), so no kept manifest ever loses its dump to pruning.
   */
  @GenerateSql({ params: [DummyValue.STRING] })
  async getKeptDatabaseKeys(bucket: string): Promise<Set<string>> {
    const rows = await this.db
      .selectFrom('cloud_backup_manifest')
      .select('databaseKey')
      .where('bucket', '=', bucket)
      .where('status', 'in', [...KEPT_MANIFEST_STATUSES])
      .where('databaseKey', 'is not', null)
      .execute();
    return new Set(rows.map(({ databaseKey }) => databaseKey!));
  }
  /** FL-164: which of these manifest keys this server has a record of, in any state. */
  @GenerateSql({ params: [DummyValue.STRING, [DummyValue.STRING]] })
  async getManifestKeys(bucket: string, keys: string[]): Promise<Set<string>> {
    if (keys.length === 0) {
      return new Set();
    }
    const rows = await this.db
      .selectFrom('cloud_backup_manifest')
      .select('key')
      .where('bucket', '=', bucket)
      .where('key', 'in', [...new Set(keys)])
      .execute();
    return new Set(rows.map(({ key }) => key));
  }
  /**
   * FL-164: record manifests found in the bucket that this server has no record of (a bucket claimed
   * again, or a database restored from before them) as complete, so they can be listed and restored from.
   * A key already recorded, in any state, is left as it is.
   */
  @GenerateSql({
    params: [
      DummyValue.STRING,
      [
        {
          key: DummyValue.STRING,
          createdAt: DummyValue.DATE,
          databaseKey: DummyValue.STRING,
          assetCount: DummyValue.NUMBER,
          fileCount: DummyValue.NUMBER,
          bytes: DummyValue.NUMBER,
        },
      ],
    ],
  })
  async adoptManifests(bucket: string, manifests: CloudBackupAdoptedManifest[]): Promise<number> {
    const known = await this.getManifestKeys(
      bucket,
      manifests.map(({ key }) => key),
    );
    const fresh = manifests.filter(({ key }) => !known.has(key));
    if (fresh.length === 0) {
      return 0;
    }
    await this.db
      .insertInto('cloud_backup_manifest')
      .values(
        fresh.map((manifest) => ({
          bucket,
          key: manifest.key,
          databaseKey: manifest.databaseKey,
          operationId: null,
          createdAt: manifest.createdAt,
          finishedAt: manifest.createdAt,
          assetCount: manifest.assetCount,
          fileCount: manifest.fileCount,
          bytes: manifest.bytes,
          status: 'complete',
        })),
      )
      .execute();
    return fresh.length;
  }
  /** FL-164: this bucket's kept manifests, newest first: what a restore can be made from. */
  @GenerateSql({ params: [DummyValue.STRING] })
  async listKeptManifests(bucket: string): Promise<CloudBackupKeptManifest[]> {
    const rows = await this.db
      .selectFrom('cloud_backup_manifest')
      .select(['key', 'status', 'databaseKey', 'createdAt', 'finishedAt', 'assetCount', 'fileCount', 'bytes'])
      .where('bucket', '=', bucket)
      .where('status', 'in', [...KEPT_MANIFEST_STATUSES])
      .orderBy('createdAt', 'desc')
      .execute();
    return rows.map((row) => ({
      key: row.key,
      status: row.status as CloudBackupKeptManifest['status'],
      databaseKey: row.databaseKey,
      createdAt: new Date(row.createdAt as unknown as string),
      finishedAt: row.finishedAt ? new Date(row.finishedAt as unknown as string) : null,
      assetCount: row.assetCount,
      fileCount: row.fileCount,
      bytes: Number(row.bytes),
    }));
  }
  /**
   * FL-164: mark manifests by their bucket key: `pruned` once retention removed them from the bucket,
   * `degraded` when a verification found an object they name missing or damaged. A pruned manifest stays
   * pruned whatever a later verification says.
   */
  @GenerateSql({ params: [DummyValue.STRING, [DummyValue.STRING], 'degraded'] })
  async markManifests(bucket: string, keys: string[], status: 'pruned' | 'degraded'): Promise<number> {
    if (keys.length === 0) {
      return 0;
    }
    const result = await this.db
      .updateTable('cloud_backup_manifest')
      .set({ status })
      .where('bucket', '=', bucket)
      .where('key', 'in', [...new Set(keys)])
      .where('status', 'in', [...KEPT_MANIFEST_STATUSES])
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }
  /**
   * FL-164: forget objects that are no longer in the bucket (removed by retention, or found missing or
   * damaged by a verification), so the next run uploads them again from this server's files. Forgetting
   * one that is still there costs one upload of the same bytes; remembering one that is gone would skip it.
   */
  @GenerateSql({ params: [DummyValue.STRING, [DummyValue.STRING]] })
  async forget(bucket: string, hashes: string[]): Promise<void> {
    if (hashes.length === 0) {
      return;
    }
    await this.db
      .deleteFrom('cloud_backup_object')
      .where('bucket', '=', bucket)
      .where('sha256', 'in', [...new Set(hashes)])
      .execute();
  }
  /**
   * FL-164: which of these assets are in the library now, for the restore list: active, trashed, or gone.
   * Backend work that sees Locked assets too; the caller is an administrator's restore of the whole server.
   */
  @GenerateSql({ params: [[DummyValue.UUID]] })
  async getLibraryState(assetIds: string[]): Promise<Map<string, CloudBackupLibraryAsset>> {
    if (assetIds.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .selectFrom('asset')
      .select(['id', 'status', 'deletedAt', 'originalFileName', 'originalPath', 'ownerId', 'isExternal'])
      .select(isLocked('asset').as('locked'))
      .where('id', '=', sql<string>`any(${[...new Set(assetIds)]}::uuid[])`)
      .where('status', 'in', [AssetStatus.Active, AssetStatus.Trashed])
      .execute();
    return new Map(
      rows.map((row) => [
        row.id,
        {
          status: row.status === AssetStatus.Active && !row.deletedAt ? ('active' as const) : ('trashed' as const),
          originalFileName: row.originalFileName,
          originalPath: row.originalPath,
          ownerId: row.ownerId,
          isExternal: row.isExternal,
          locked: !!row.locked,
        },
      ]),
    );
  }
  /** Presence and caller privacy from one snapshot, including non-active rows that cannot be treated as absent. */
  async getOwnerHistoryState(auth: AuthDto, assetIds: string[]): Promise<Map<string, OwnerBackupState>> {
    if (assetIds.length === 0) return new Map();
    const execute = async (trx: Kysely<DB>) => {
      const rows = await trx
        .selectFrom('asset')
        .select(['id', 'ownerId', 'status', 'deletedAt'])
        .where('id', '=', sql<string>`any(${assetIds}::uuid[])`)
        .execute();
      const allowed = await trx
        .selectFrom('asset')
        .leftJoin('library', 'library.id', 'asset.libraryId')
        .select('asset.id')
        .where('asset.id', '=', sql<string>`any(${assetIds}::uuid[])`)
        .where('asset.ownerId', '=', auth.user.id)
        .where((eb) =>
          eb.or([
            eb('asset.libraryId', 'is', null),
            eb.and([eb('library.ownerId', '=', auth.user.id), eb('library.deletedAt', 'is', null)]),
          ]),
        )
        .$if(!auth.session?.hasElevatedPermission, (qb) =>
          qb.where(isNotLocked('asset')).where((eb) => eb.not(isMotionOfLockedStill(eb))),
        )
        .$call((qb) =>
          withHiddenContentFilter(qb, { hiddenContent: auth.hiddenContent, excludeNsfw: auth.hideNsfwAssets }),
        )
        .execute();
      const visible = new Set(allowed.map(({ id }) => id));
      const deleted = await trx
        .selectFrom('asset_backup_deletion')
        .selectAll()
        .where('ownerId', '=', auth.user.id)
        .where('assetId', '=', sql<string>`any(${assetIds}::uuid[])`)
        .execute();
      const result = new Map<string, OwnerBackupState>(
        rows.map((row) => [
          row.id,
          { ...row, deletedAt: row.deletedAt ? new Date(row.deletedAt) : null, allowed: visible.has(row.id) },
        ]),
      );
      for (const row of deleted)
        result.set(row.assetId, {
          ...result.get(row.assetId),
          deletion: { ...row, deletedAt: new Date(row.deletedAt) },
        });
      return result;
    };
    return this.db.isTransaction
      ? execute(this.db)
      : this.db.transaction().setIsolationLevel('repeatable read').execute(execute);
  }
  async getOwnerRestoreIdentities(ids: string[]) {
    const rows = await this.db
      .selectFrom('asset')
      .select(['id', 'ownerId', 'originalPath', 'checksum', 'checksumAlgorithm', 'isExternal'])
      .where('id', '=', sql<string>`any(${ids}::uuid[])`)
      .execute();
    return Object.fromEntries(
      rows.map(({ id, checksum, ...rest }) => [id, { ...rest, checksum: checksum.toString('hex') }]),
    );
  }
  async getOwnerRestoreAuth(owner: { ownerId: string; sessionId: string }): Promise<{
    auth: AuthDto;
    storageLabel: string | null;
  }> {
    const row = await this.db
      .selectFrom('user')
      .innerJoin('session', 'session.userId', 'user.id')
      .select([
        'user.id',
        'user.name',
        'user.email',
        'user.isAdmin',
        'user.quotaUsageInBytes',
        'user.quotaSizeInBytes',
        'user.storageLabel',
      ])
      .where('user.id', '=', owner.ownerId)
      .where('user.deletedAt', 'is', null)
      .where('session.id', '=', owner.sessionId)
      .where('session.pinExpiresAt', '>', sql<Date>`clock_timestamp()`)
      .where((eb) =>
        eb.or([eb('session.expiresAt', 'is', null), eb('session.expiresAt', '>', sql<Date>`clock_timestamp()`)]),
      )
      .executeTakeFirst();
    if (!row) throw new Error('Owner restore authorization unavailable');
    // Matches normal AuthService elevated semantics: current suppression rules do not hide revealed content.
    return {
      auth: { user: row, session: { id: owner.sessionId, hasElevatedPermission: true } },
      storageLabel: row.storageLabel,
    };
  }
  async withOwnerRestore<T>(
    owner: {
      ownerId: string;
      sessionId: string;
    },
    identity: {
      bucketRef: string;
      keyFingerprint: string;
      manifestKey: string;
    },
    assetId: string,
    lease: {
      operationId: string;
      claimToken: string;
    },
    callback: (trx: Transaction<DB>) => Promise<T>,
    buddy?: {
      authorize: () => Promise<void>;
    },
  ): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      const operation = await trx
        .selectFrom('media_operation')
        .select('id')
        .where('id', '=', lease.operationId)
        .where('kind', '=', buddy ? MediaOperationKind.BuddyRestore : MediaOperationKind.CloudRestore)
        .where('ownerId', '=', owner.ownerId)
        .where('claimToken', '=', lease.claimToken)
        .where('status', '=', MediaOperationStatus.Rendering)
        .where('claimExpiresAt', '>', sql<Date>`clock_timestamp()`)
        .where('cancelRequestedAt', 'is', null)
        .where('pauseRequestedAt', 'is', null)
        .forShare()
        .noWait()
        .executeTakeFirst();
      if (!operation) throw new Error('Owner restore claim unavailable');
      const session = await trx
        .selectFrom('session')
        .select('id')
        .where('id', '=', owner.sessionId)
        .where('userId', '=', owner.ownerId)
        .where('pinExpiresAt', '>', sql<Date>`clock_timestamp()`)
        .where((eb) => eb.or([eb('expiresAt', 'is', null), eb('expiresAt', '>', sql<Date>`clock_timestamp()`)]))
        .forShare()
        .noWait()
        .executeTakeFirst();
      const user = await trx
        .selectFrom('user')
        .select('id')
        .where('id', '=', owner.ownerId)
        .where('deletedAt', 'is', null)
        .forShare()
        .noWait()
        .executeTakeFirst();
      if (!session || !user) throw new Error('Owner restore authorization unavailable');
      await trx
        .selectFrom('user_metadata')
        .select('key')
        .where('userId', '=', owner.ownerId)
        .forShare()
        .noWait()
        .execute();
      if (buddy) {
        // Buddy has a separately authenticated encrypted manifest; current owner/session/item locks below remain identical.
        await buddy.authorize();
      } else {
        const kept = await trx
          .selectFrom('cloud_backup_manifest')
          .select('id')
          .where('bucket', '=', identity.bucketRef)
          .where('key', '=', identity.manifestKey)
          .where('status', 'in', ['complete', 'degraded'])
          .forShare()
          .noWait()
          .executeTakeFirst();
        const metadata = await trx
          .selectFrom('system_metadata')
          .select('value')
          .where('key', '=', SystemMetadataKey.FrameleafCloudBackup)
          .forShare()
          .noWait()
          .executeTakeFirst();
        const claim = metadata?.value as
          | {
              bucketRef?: string;
              keyFingerprint?: string;
              target?: string;
            }
          | undefined;
        const storedConfig = await trx
          .selectFrom('system_metadata')
          .select('value')
          .where('key', '=', SystemMetadataKey.SystemConfig)
          .forShare()
          .noWait()
          .executeTakeFirst();
        const partial = (storedConfig?.value as SystemMetadata[SystemMetadataKey.SystemConfig] | undefined)
          ?.frameleafCloud?.cloudBackup;
        const fallback = defaults.frameleafCloud.cloudBackup;
        const target = partial?.target ?? fallback.target;
        if (
          !storedConfig ||
          !(partial?.enabled ?? fallback.enabled) ||
          target === 'off' ||
          target !== claim?.target ||
          (target === 'byo-s3' &&
            bucketRef(partial?.s3?.endpoint ?? fallback.s3.endpoint, partial?.s3?.bucket ?? fallback.s3.bucket) !==
              identity.bucketRef)
        )
          throw new Error('Owner restore configuration unavailable');
        if (!kept || claim?.bucketRef !== identity.bucketRef || claim.keyFingerprint !== identity.keyFingerprint)
          throw new Error('Owner restore backup unavailable');
      }
      // Lock the current item and its immediate authority rows, never across remote I/O.
      const asset = await trx
        .selectFrom('asset')
        .select(['ownerId', 'libraryId'])
        .where('id', '=', assetId)
        .forUpdate()
        .noWait()
        .executeTakeFirst();
      if (asset && asset.ownerId !== owner.ownerId) throw new Error('Owner restore item unavailable');
      if (asset?.libraryId) {
        const library = await trx
          .selectFrom('library')
          .select(['ownerId', 'deletedAt'])
          .where('id', '=', asset.libraryId)
          .forShare()
          .noWait()
          .executeTakeFirst();
        if (!library || library.ownerId !== owner.ownerId || library.deletedAt)
          throw new Error('Owner restore library unavailable');
      }
      await trx
        .selectFrom('asset_backup_deletion')
        .select('assetId')
        .where('assetId', '=', assetId)
        .forUpdate()
        .noWait()
        .execute();
      return callback(trx);
    });
  }
  /** FL-164: the names of these accounts, for the restore list's owner column. */
  @GenerateSql({ params: [[DummyValue.UUID]] })
  async getOwnerNames(userIds: string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .selectFrom('user')
      .select(['id', 'name'])
      .where('id', 'in', [...new Set(userIds)])
      .execute();
    return new Map(rows.map(({ id, name }) => [id, name]));
  }
  /**
   * End every running manifest whose run is over or gone (a run the lease sweep failed, or one removed):
   * it is marked failed and its recorded files are deleted. Answers how many were ended.
   */
  @GenerateSql()
  async endAbandonedManifests(): Promise<number> {
    const ended = await this.db
      .updateTable('cloud_backup_manifest')
      .set({ status: 'failed', finishedAt: sql<Date>`now()` })
      .where('status', '=', 'running')
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('media_operation')
              .select('media_operation.id')
              .whereRef('media_operation.id', '=', 'cloud_backup_manifest.operationId')
              .where('media_operation.status', 'not in', FINISHED_OPERATIONS),
          ),
        ),
      )
      .returning('id')
      .execute();
    if (ended.length > 0) {
      await this.db
        .deleteFrom('cloud_backup_manifest_entry')
        .where(
          'manifestId',
          'in',
          ended.map(({ id }) => id),
        )
        .execute();
    }
    return ended.length;
  }
  /** Record files of a running manifest; a file recorded again is replaced. */
  @GenerateSql({
    params: [
      DummyValue.UUID,
      [
        {
          fileKey: DummyValue.STRING,
          assetId: DummyValue.UUID,
          ownerId: DummyValue.UUID,
          role: DummyValue.STRING,
          path: DummyValue.STRING,
          sha256: DummyValue.STRING,
          size: DummyValue.NUMBER,
          mtime: DummyValue.DATE,
        },
      ],
    ],
  })
  async upsertEntries(manifestId: string, entries: CloudBackupEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    const unique = new Map(entries.map((entry) => [entry.fileKey, entry])).values().toArray();
    await this.db
      .insertInto('cloud_backup_manifest_entry')
      .values(unique.map((entry) => ({ ...entry, manifestId })))
      .onConflict((oc) =>
        oc.columns(['manifestId', 'fileKey']).doUpdateSet((eb) => ({
          assetId: eb.ref('excluded.assetId'),
          ownerId: eb.ref('excluded.ownerId'),
          role: eb.ref('excluded.role'),
          path: eb.ref('excluded.path'),
          sha256: eb.ref('excluded.sha256'),
          size: eb.ref('excluded.size'),
          mtime: eb.ref('excluded.mtime'),
        })),
      )
      .execute();
  }
  /** A page of a manifest's files in `fileKey` order, after `afterFileKey`: an asset's files are adjacent. */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING, DummyValue.NUMBER] })
  async getEntriesPage(manifestId: string, afterFileKey: string | null, limit: number): Promise<CloudBackupEntry[]> {
    const rows = await this.db
      .selectFrom('cloud_backup_manifest_entry')
      .select(ENTRY_COLUMNS)
      .where('manifestId', '=', manifestId)
      .$if(afterFileKey !== null, (qb) => qb.where('fileKey', '>', afterFileKey!))
      .orderBy('fileKey')
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      ...row,
      size: Number(row.size),
      mtime: row.mtime ? new Date(row.mtime as unknown as string) : null,
    }));
  }
  @GenerateSql({ params: [DummyValue.UUID] })
  async deleteEntries(manifestId: string): Promise<void> {
    await this.db.deleteFrom('cloud_backup_manifest_entry').where('manifestId', '=', manifestId).execute();
  }
  /** How many assets a run backs up. */
  @GenerateSql()
  async countAssets(): Promise<number> {
    const row = await this.db
      .selectFrom('asset')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('status', 'in', [AssetStatus.Active, AssetStatus.Trashed])
      .where('isExternal', '=', false)
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }
  /**
   * The next assets after `afterId`, in id order, with the SHA-256 on record and their files: the
   * sidecar always, thumbnails and previews and transcoded videos only when asked for. Every owner's
   * assets, Locked and trashed ones included; external library files are not this server's to back up.
   */
  @GenerateSql({
    params: [
      {
        afterId: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
        limit: DummyValue.NUMBER,
        includeThumbs: DummyValue.BOOLEAN,
        includeEncodedVideo: DummyValue.BOOLEAN,
      },
    ],
  })
  async listAssets(options: {
    afterId: string | null;
    limit: number;
    includeThumbs: boolean;
    includeEncodedVideo: boolean;
    includeExternal?: boolean;
  }): Promise<CloudBackupAsset[]> {
    const assets = await this.db
      .selectFrom('asset')
      .select(['id', 'ownerId', 'originalPath'])
      .where('status', 'in', [AssetStatus.Active, AssetStatus.Trashed])
      .$if(!options.includeExternal, (query) => query.where('isExternal', '=', false))
      .$if(options.afterId !== null, (qb) => qb.where('id', '>', options.afterId!))
      .orderBy('id')
      .limit(options.limit)
      .execute();
    if (assets.length === 0) {
      return [];
    }
    const ids = assets.map(({ id }) => id);
    const checksums = await sql<{
      assetId: string;
      sha256: string;
      size: string;
      verifiedAt: Date;
      verifiedPaths: string[];
    }>`
      select "assetId", encode("sha256", 'hex') as "sha256", "sizeInBytes"::text as "size", "verifiedAt", "verifiedPaths"
      from public.asset_checksum
      where "assetId" = any(${ids}::uuid[])
    `.execute(this.db);
    const checksumOf = new Map(checksums.rows.map((row) => [row.assetId, row]));
    const types: AssetFileType[] = [AssetFileType.Sidecar];
    if (options.includeThumbs) {
      types.push(
        AssetFileType.FullSize,
        AssetFileType.Preview,
        AssetFileType.Thumbnail,
        AssetFileType.HdrPreview,
        AssetFileType.HdrFullSize,
      );
    }
    if (options.includeEncodedVideo) {
      types.push(AssetFileType.EncodedVideo);
    }
    const files = await this.db
      .selectFrom('asset_file')
      .select(['assetId', 'type', 'path'])
      .where('assetId', 'in', ids)
      .where('type', 'in', types)
      .orderBy('assetId')
      .orderBy('type')
      .orderBy('path')
      .execute();
    return assets.map((asset) => {
      const checksum = checksumOf.get(asset.id);
      return {
        id: asset.id,
        ownerId: asset.ownerId,
        originalPath: asset.originalPath,
        sha256: checksum?.sha256 ?? null,
        checksumSize: checksum ? Number(checksum.size) : null,
        verifiedAt: checksum ? new Date(checksum.verifiedAt) : null,
        checksumPathVerified: !!checksum?.verifiedPaths.includes(asset.originalPath),
        files: files
          .filter(({ assetId }) => assetId === asset.id)
          .map(({ type, path }) => ({ type: type as AssetFileType, path })),
      };
    });
  }
  /**
   * FL-164 (manifest v2): each item's record and the details that live in the database rather than in
   * its file (favourite, visibility, rating, description, date and place, tags, albums, faces, stack and
   * edits), for the manifest a run writes. Backend work: Locked items included.
   */
  // No @GenerateSql: several plain reads assembled here, each covered by the medium spec.
  async getAssetDetails(assetIds: string[]): Promise<
    Map<
      string,
      {
        record: CloudBackupAssetRecord;
        details: CloudBackupAssetDetails;
      }
    >
  > {
    const ids = [...new Set(assetIds)];
    if (ids.length === 0) {
      return new Map();
    }
    const [assets, tags, albums, faces, edits] = await Promise.all([
      this.db
        .selectFrom('asset')
        .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
        .leftJoin('stack', 'stack.id', 'asset.stackId')
        .select([
          'asset.id',
          'asset.type',
          'asset.originalFileName',
          'asset.fileCreatedAt',
          'asset.fileModifiedAt',
          'asset.localDateTime',
          'asset.duration',
          'asset.isFavorite',
          'asset.visibility',
          'asset.stackId',
          'stack.primaryAssetId',
          'asset_exif.rating',
          'asset_exif.description',
          'asset_exif.dateTimeOriginal',
          'asset_exif.timeZone',
          'asset_exif.latitude',
          'asset_exif.longitude',
        ])
        .select(isLocked('asset').as('isLocked'))
        .where('asset.id', '=', sql<string>`any(${ids}::uuid[])`)
        .execute(),
      this.db
        .selectFrom('tag_asset')
        .innerJoin('tag', 'tag.id', 'tag_asset.tagId')
        .select(['tag_asset.assetId', 'tag.value'])
        .where('tag_asset.assetId', '=', sql<string>`any(${ids}::uuid[])`)
        .orderBy('tag.value')
        .execute(),
      this.db
        .selectFrom('album_asset')
        .innerJoin('album', 'album.id', 'album_asset.albumId')
        .select(['album_asset.assetId', 'album.id', 'album.albumName'])
        .where('album_asset.assetId', '=', sql<string>`any(${ids}::uuid[])`)
        .where('album.deletedAt', 'is', null)
        .orderBy('album.id')
        .execute(),
      this.db
        .selectFrom('asset_face')
        .select([
          'assetId',
          'personGroupId',
          'boundingBoxX1',
          'boundingBoxY1',
          'boundingBoxX2',
          'boundingBoxY2',
          'imageWidth',
          'imageHeight',
          'isVisible',
        ])
        .where('assetId', '=', sql<string>`any(${ids}::uuid[])`)
        .where('deletedAt', 'is', null)
        .orderBy('id')
        .execute(),
      this.db
        .selectFrom('asset_edit')
        .select(['assetId', 'action', 'parameters'])
        .where('assetId', '=', sql<string>`any(${ids}::uuid[])`)
        .orderBy('sequence')
        .execute(),
    ]);
    const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);
    const grouped = <
      T extends {
        assetId: string;
      },
    >(
      rows: T[],
    ) => {
      const map = new Map<string, T[]>();
      for (const row of rows) {
        map.set(row.assetId, [...(map.get(row.assetId) ?? []), row]);
      }
      return map;
    };
    const tagsOf = grouped(tags);
    const albumsOf = grouped(albums);
    const facesOf = grouped(faces);
    const editsOf = grouped(edits);
    return new Map(
      assets.map((asset) => [
        asset.id,
        {
          record: {
            type: asset.type,
            originalFileName: asset.originalFileName,
            fileCreatedAt: iso(asset.fileCreatedAt)!,
            fileModifiedAt: iso(asset.fileModifiedAt)!,
            localDateTime: iso(asset.localDateTime)!,
            duration: asset.duration ?? null,
          },
          details: {
            isFavorite: asset.isFavorite,
            visibility: effectiveVisibilityOf({
              visibility: asset.visibility,
              isLocked: !!asset.isLocked,
            }) as CloudBackupAssetDetails['visibility'],
            rating: asset.rating ?? null,
            description: asset.description ?? '',
            dateTimeOriginal: iso(asset.dateTimeOriginal),
            timeZone: asset.timeZone ?? null,
            latitude: asset.latitude ?? null,
            longitude: asset.longitude ?? null,
            tags: (tagsOf.get(asset.id) ?? []).map(({ value }) => value),
            albums: (albumsOf.get(asset.id) ?? []).map(({ id, albumName }) => ({ id, name: albumName })),
            faces: (facesOf.get(asset.id) ?? []).map((face) => ({
              personId: face.personGroupId,
              box: [face.boundingBoxX1, face.boundingBoxY1, face.boundingBoxX2, face.boundingBoxY2] as [
                number,
                number,
                number,
                number,
              ],
              imageWidth: face.imageWidth,
              imageHeight: face.imageHeight,
              isHidden: !face.isVisible,
            })),
            stack: asset.stackId ? { id: asset.stackId, isPrimary: asset.primaryAssetId === asset.id } : null,
            edits: (editsOf.get(asset.id) ?? []).map(({ action, parameters }) => ({
              action,
              parameters: parameters as unknown as Record<string, unknown>,
            })),
          },
        },
      ]),
    );
  }
  /** FL-164 (manifest v2): these albums as a deleted one is made again: name, cover, order, owner, sharing. */
  // No @GenerateSql: covered by the medium spec.
  async getAlbumRecords(albumIds: string[]): Promise<Map<string, CloudBackupAlbum>> {
    const ids = [...new Set(albumIds)];
    if (ids.length === 0) {
      return new Map();
    }
    const [albums, users] = await Promise.all([
      this.db
        .selectFrom('album')
        .select(['id', 'albumName', 'description', 'albumThumbnailAssetId', 'order'])
        .where('id', '=', sql<string>`any(${ids}::uuid[])`)
        .where('deletedAt', 'is', null)
        .execute(),
      this.db
        .selectFrom('album_user')
        .select(['albumId', 'userId', 'role'])
        .where('albumId', '=', sql<string>`any(${ids}::uuid[])`)
        .orderBy('userId')
        .execute(),
    ]);
    const records = new Map<string, CloudBackupAlbum>();
    for (const album of albums) {
      const members = users.filter(({ albumId }) => albumId === album.id);
      const owner = members.find(({ role }) => role === 'owner');
      if (!owner) {
        continue;
      }
      records.set(album.id, {
        name: album.albumName,
        description: album.description ?? '',
        ownerId: owner.userId,
        coverAssetId: album.albumThumbnailAssetId,
        order: album.order as CloudBackupAlbum['order'],
        sharedUsers: members
          .filter(({ role }) => role !== 'owner')
          .map(({ userId, role }) => ({ userId, role: role as 'editor' | 'viewer' })),
      });
    }
    return records;
  }
  /**
   * FL-164 (manifest v2): the people these faces name, as each face's owner sees them (a person is one
   * owner's name for a person group).
   */
  // No @GenerateSql: covered by the medium spec.
  async getPersonRecords(
    pairs: Array<{
      ownerId: string;
      personId: string;
    }>,
  ): Promise<Map<string, CloudBackupPerson>> {
    const groupIds = [...new Set(pairs.map(({ personId }) => personId))];
    if (groupIds.length === 0) {
      return new Map();
    }
    const wanted = new Set(pairs.map(({ ownerId, personId }) => `${ownerId}:${personId}`));
    const rows = await this.db
      .selectFrom('person')
      .select(['ownerId', 'personGroupId', 'name', 'birthDate', 'isHidden', 'isFavorite'])
      .where('personGroupId', '=', sql<string>`any(${groupIds}::uuid[])`)
      .orderBy('personGroupId')
      .orderBy('ownerId')
      .execute();
    const records = new Map<string, CloudBackupPerson>();
    for (const row of rows) {
      if (!wanted.has(`${row.ownerId}:${row.personGroupId}`) || records.has(row.personGroupId)) {
        continue;
      }
      records.set(row.personGroupId, {
        ownerId: row.ownerId,
        name: row.name,
        birthDate: row.birthDate ? new Date(row.birthDate as unknown as string).toISOString().slice(0, 10) : null,
        isHidden: row.isHidden,
        isFavorite: row.isFavorite,
      });
    }
    return records;
  }
  /** FL-164: the items each of these albums holds now; an album that is gone is left out. */
  // No @GenerateSql: covered by the medium spec.
  async getAlbumMembers(albumIds: string[]): Promise<Map<string, Set<string>>> {
    const ids = [...new Set(albumIds)];
    if (ids.length === 0) {
      return new Map();
    }
    const [albums, members] = await Promise.all([
      this.db
        .selectFrom('album')
        .select('id')
        .where('id', '=', sql<string>`any(${ids}::uuid[])`)
        .where('deletedAt', 'is', null)
        .execute(),
      this.db
        .selectFrom('album_asset')
        .select(['albumId', 'assetId'])
        .where('albumId', '=', sql<string>`any(${ids}::uuid[])`)
        .execute(),
    ]);
    const held = new Map(albums.map(({ id }) => [id, new Set<string>()]));
    for (const { albumId, assetId } of members) {
      held.get(albumId)?.add(assetId);
    }
    return held;
  }
  /** Every account's profile image. */
  @GenerateSql()
  async listProfileImages(): Promise<
    Array<{
      userId: string;
      path: string;
    }>
  > {
    const rows = await this.db
      .selectFrom('user')
      .select(['id', 'profileImagePath'])
      .where('profileImagePath', '!=', '')
      .where('deletedAt', 'is', null)
      .orderBy('id')
      .execute();
    return rows.map(({ id, profileImagePath }) => ({ userId: id, path: profileImagePath }));
  }
}
