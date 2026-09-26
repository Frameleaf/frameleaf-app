import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { AssetFileType, AssetStatus } from 'src/enum.js';
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
  files: Array<{ type: AssetFileType; path: string }>;
};

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
  async record(bucket: string, objects: CloudBackupIndexedObject[]): Promise<void> {
    if (objects.length === 0) {
      return;
    }
    const unique = [...new Map(objects.map((object) => [object.sha256, object])).values()];
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

  /** How many unique files the bucket holds for this server, and their size. */
  async getUsage(bucket: string): Promise<{ objects: number; bytes: number }> {
    const row = await this.db
      .selectFrom('cloud_backup_object')
      .select((eb) => [eb.fn.countAll<string>().as('objects'), sql<string>`coalesce(sum("size"), 0)`.as('bytes')])
      .where('bucket', '=', bucket)
      .executeTakeFirst();
    return { objects: Number(row?.objects ?? 0), bytes: Number(row?.bytes ?? 0) };
  }

  async createManifest(values: { bucket: string; key: string; operationId: string }): Promise<CloudBackupManifestRow> {
    return this.db
      .insertInto('cloud_backup_manifest')
      .values(values)
      .returning(['id', 'bucket', 'key', 'operationId', 'status', 'createdAt'])
      .executeTakeFirstOrThrow() as Promise<CloudBackupManifestRow>;
  }

  async getManifest(id: string): Promise<CloudBackupManifestRow | undefined> {
    return this.db
      .selectFrom('cloud_backup_manifest')
      .select(['id', 'bucket', 'key', 'operationId', 'status', 'createdAt'])
      .where('id', '=', id)
      .executeTakeFirst() as Promise<CloudBackupManifestRow | undefined>;
  }

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

  /** Record files of a running manifest; a file recorded again is replaced. */
  async upsertEntries(manifestId: string, entries: CloudBackupEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    const unique = [...new Map(entries.map((entry) => [entry.fileKey, entry])).values()];
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

  async getEntries(manifestId: string): Promise<CloudBackupEntry[]> {
    const rows = await this.db
      .selectFrom('cloud_backup_manifest_entry')
      .select(['fileKey', 'assetId', 'ownerId', 'role', 'path', 'sha256', 'size', 'mtime'])
      .where('manifestId', '=', manifestId)
      .orderBy('fileKey')
      .execute();
    return rows.map((row) => ({
      ...row,
      size: Number(row.size),
      mtime: row.mtime ? new Date(row.mtime as unknown as string) : null,
    }));
  }

  async deleteEntries(manifestId: string): Promise<void> {
    await this.db.deleteFrom('cloud_backup_manifest_entry').where('manifestId', '=', manifestId).execute();
  }

  /** How many assets a run backs up. */
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
  async listAssets(options: {
    afterId: string | null;
    limit: number;
    includeThumbs: boolean;
    includeEncodedVideo: boolean;
  }): Promise<CloudBackupAsset[]> {
    const types: AssetFileType[] = [AssetFileType.Sidecar];
    if (options.includeThumbs) {
      types.push(AssetFileType.FullSize, AssetFileType.Preview, AssetFileType.Thumbnail);
    }
    if (options.includeEncodedVideo) {
      types.push(AssetFileType.EncodedVideo);
    }

    const result = await sql<{
      id: string;
      ownerId: string;
      originalPath: string;
      sha256: string | null;
      checksumSize: string | null;
      verifiedAt: Date | null;
      files: Array<{ type: AssetFileType; path: string }> | null;
    }>`
      SELECT
        a."id",
        a."ownerId",
        a."originalPath",
        encode(c."sha256", 'hex') AS "sha256",
        c."sizeInBytes"::text AS "checksumSize",
        c."verifiedAt",
        (
          SELECT json_agg(json_build_object('type', f."type", 'path', f."path") ORDER BY f."type", f."path")
          FROM "asset_file" f
          WHERE f."assetId" = a."id" AND f."type" = ANY(${types}::text[])
        ) AS "files"
      FROM "asset" a
      LEFT JOIN immich_fork.asset_checksum c ON c."assetId" = a."id"
      WHERE a."status"::text = ANY(${[AssetStatus.Active, AssetStatus.Trashed]}::text[])
        AND a."isExternal" = false
        AND (${options.afterId}::uuid IS NULL OR a."id" > ${options.afterId}::uuid)
      ORDER BY a."id"
      LIMIT ${options.limit}
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: row.id,
      ownerId: row.ownerId,
      originalPath: row.originalPath,
      sha256: row.sha256,
      checksumSize: row.checksumSize === null ? null : Number(row.checksumSize),
      verifiedAt: row.verifiedAt ? new Date(row.verifiedAt) : null,
      files: row.files ?? [],
    }));
  }

  /** Every account's profile image. */
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
