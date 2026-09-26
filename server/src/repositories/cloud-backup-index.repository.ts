import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AssetFileType, AssetStatus, MediaOperationStatus } from 'src/enum.js';
import { DB } from 'src/schema/index.js';

export type CloudBackupIndexedObject = { sha256: string; size: number; etag: string | null };

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
  /** Lowercase hex SHA-256 from `immich_fork.asset_checksum`, or null when none is recorded. */
  sha256: string | null;
  checksumSize: number | null;
  verifiedAt: Date | null;
  /** The checksum was verified at this very path (`verifiedPaths` holds the original's path). */
  checksumPathVerified: boolean;
  files: Array<{ type: AssetFileType; path: string }>;
};

const MANIFEST_COLUMNS = ['id', 'bucket', 'key', 'operationId', 'status', 'createdAt'] as const;
const ENTRY_COLUMNS = ['fileKey', 'assetId', 'ownerId', 'role', 'path', 'sha256', 'size', 'mtime'] as const;
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
  constructor(@InjectKysely() private db: Kysely<DB>) {}

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
  async getUsage(bucket: string): Promise<{ objects: number; bytes: number }> {
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
    values: { status: 'complete' | 'cancelled' | 'failed'; assetCount?: number; fileCount?: number; bytes?: number },
  ): Promise<void> {
    await this.db
      .updateTable('cloud_backup_manifest')
      .set({ ...values, finishedAt: sql<Date>`now()` })
      .where('id', '=', id)
      .execute();
  }

  /** The database dump a manifest names, so no complete manifest ever loses its dump to pruning. */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  async setManifestDatabase(id: string, databaseKey: string): Promise<void> {
    await this.db.updateTable('cloud_backup_manifest').set({ databaseKey }).where('id', '=', id).execute();
  }

  /** The database dump the newest complete manifest of this bucket names, if any. */
  @GenerateSql({ params: [DummyValue.STRING] })
  async getLatestManifestDatabaseKey(bucket: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('cloud_backup_manifest')
      .select('databaseKey')
      .where('bucket', '=', bucket)
      .where('status', '=', 'complete')
      .where('databaseKey', 'is not', null)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row?.databaseKey ?? null;
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
  }): Promise<CloudBackupAsset[]> {
    const assets = await this.db
      .selectFrom('asset')
      .select(['id', 'ownerId', 'originalPath'])
      .where('status', 'in', [AssetStatus.Active, AssetStatus.Trashed])
      .where('isExternal', '=', false)
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
      from immich_fork.asset_checksum
      where "assetId" = any(${ids}::uuid[])
    `.execute(this.db);
    const checksumOf = new Map(checksums.rows.map((row) => [row.assetId, row]));

    const types: AssetFileType[] = [AssetFileType.Sidecar];
    if (options.includeThumbs) {
      types.push(AssetFileType.FullSize, AssetFileType.Preview, AssetFileType.Thumbnail);
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

  /** Every account's profile image. */
  @GenerateSql()
  async listProfileImages(): Promise<Array<{ userId: string; path: string }>> {
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
