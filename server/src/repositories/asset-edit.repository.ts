import { Injectable } from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash } from 'node:crypto';
import type { ForkSchemaPhase } from 'src/repositories/fork-schema.repository.js';
import { columns } from 'src/database.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AssetEditActionItem, AssetEditActionItemResponseDto } from 'src/dtos/editing.dto.js';
import { AssetFileType, AssetType } from 'src/enum.js';
import { isForkWriteEnabled } from 'src/fork-schema/authority.js';
import { DB } from 'src/schema/index.js';
import { getEditedMasterLineagePath } from 'src/utils/media-policy.js';

export type VideoEditVersion = {
  id: string;
  assetId: string;
  ownerId: string;
  /** The asset's current original path. A version is tied to its original by asset and checksum, not path. */
  sourcePath: string;
  sourceChecksum: Buffer;
  recipe: AssetEditActionItem[];
  purpose: 'save' | 'export' | 'revert';
  status: 'pending' | 'ready' | 'failed';
  masterPath: string | null;
  proxyPath: string | null;
  files: Array<{ path: string }>;
  createdAt: Date;
};

export type VideoVersionPublication = {
  published: boolean;
  /** Edited files the publication dropped from the asset that no retained version owns. */
  releasedPaths: string[];
};

/**
 * A retained version belongs to its asset's original by asset, owner and content checksum. The path
 * is deliberately not part of that identity: physical deduplication and the storage template may
 * move an original, and a version stays valid across the move. The current path is reported as
 * `sourcePath`.
 */
const versionColumns = sql`v.id, v."assetId", v."ownerId", a."originalPath" AS "sourcePath", v."sourceChecksum",
  v.recipe, v.purpose, v.status, v."masterPath", v."proxyPath", v.files, v."createdAt"`;
const sourceJoin = sql`JOIN public.asset a ON a.id=v."assetId" AND a."ownerId"=v."ownerId" AND a.checksum=v."sourceChecksum"`;

const versionPaths = (version: Pick<VideoEditVersion, 'masterPath' | 'proxyPath' | 'files'>) => [
  version.masterPath,
  version.masterPath && getEditedMasterLineagePath(version.masterPath),
  version.proxyPath,
  ...(version.files ?? []).map((file) => file.path),
];

@Injectable()
export class AssetEditRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID] })
  replaceAll(
    assetId: string,
    edits: AssetEditActionItem[],
    purpose: 'save' | 'revert' = 'save',
  ): Promise<AssetEditActionItemResponseDto[]> {
    return this.db.transaction().execute(async (trx) => {
      // Only video edits are versioned; a photo edit never waits on the fork schema's write phase.
      const target = await trx.selectFrom('asset').select('type').where('id', '=', assetId).executeTakeFirst();
      if (target?.type === AssetType.Video) {
        await this.recordVideoVersion(trx, assetId, edits, purpose);
      }
      await trx.deleteFrom('asset_edit').where('assetId', '=', assetId).execute();

      if (edits.length > 0) {
        return trx
          .insertInto('asset_edit')
          .values(edits.map((edit, i) => ({ assetId, sequence: i, ...edit })))
          .returning(['id', 'action', 'parameters'])
          .execute();
      }

      return [];
    });
  }

  private async lockVersionWrites(db: Kysely<DB>) {
    const { rows } = await sql<{
      phase: ForkSchemaPhase;
    }>`SELECT phase FROM immich_fork.state WHERE id=1 FOR SHARE`.execute(db);
    const handoff = await sql`SELECT 1 FROM immich_fork.migration_audit WHERE status='running'
      AND name IN ('official-handoff-preparation','fork-return-reconciliation') LIMIT 1`.execute(db);
    if (handoff.rows.length > 0) throw new Error('video_version_handoff');
    return !!rows[0] && isForkWriteEnabled(rows[0].phase);
  }

  private async recordVideoVersion(
    db: Transaction<DB>,
    assetId: string,
    recipe: AssetEditActionItem[],
    purpose: 'save' | 'revert',
  ) {
    if (!(await this.lockVersionWrites(db))) {
      const retained =
        await sql`SELECT 1 FROM immich_fork.video_edit_selection WHERE "assetId"=${assetId}::uuid`.execute(db);
      if (retained.rows.length > 0) throw new Error('video_version_inactive');
      return;
    }
    const asset = await db
      .selectFrom('asset')
      .select(['id', 'ownerId', 'originalPath', 'checksum', 'type'])
      .where('id', '=', assetId)
      .forUpdate()
      .executeTakeFirst();
    if (!asset || asset.type !== AssetType.Video) return;
    // A pending save or revert that is superseded before it renders will never be published.
    await sql`UPDATE immich_fork.video_edit_version v SET status='failed'
      FROM immich_fork.video_edit_selection s
      WHERE s."assetId"=${asset.id}::uuid AND v.id=s."requestedVersionId" AND v.status='pending'`.execute(db);
    const { rows } = await sql<VideoEditVersion>`INSERT INTO immich_fork.video_edit_version
      ("assetId","ownerId","sourcePath","sourceChecksum",recipe,purpose)
      VALUES(${asset.id}::uuid,${asset.ownerId}::uuid,${asset.originalPath},${asset.checksum},${JSON.stringify(recipe)}::text::jsonb,${purpose}) RETURNING *`.execute(
      db,
    );
    await sql`INSERT INTO immich_fork.video_edit_selection ("assetId","ownerId","requestedVersionId")
      VALUES(${asset.id}::uuid,${asset.ownerId}::uuid,${rows[0].id}::uuid)
      ON CONFLICT ("assetId") DO UPDATE SET "requestedVersionId"=excluded."requestedVersionId"`.execute(db);
  }

  async getRequestedVideoVersion(assetId: string): Promise<VideoEditVersion | undefined> {
    const { rows } = await sql<VideoEditVersion>`SELECT ${versionColumns} FROM immich_fork.video_edit_selection s
      JOIN immich_fork.video_edit_version v ON v.id=s."requestedVersionId"
      ${sourceJoin}
      WHERE s."assetId"=${assetId}::uuid`.execute(this.db);
    if (!rows[0]) {
      const retained =
        await sql`SELECT 1 FROM immich_fork.video_edit_selection WHERE "assetId"=${assetId}::uuid`.execute(this.db);
      if (retained.rows.length > 0) throw new Error('video_version_source_changed');
    }
    return rows[0];
  }

  async publishVideoVersion(
    version: VideoEditVersion,
    result: {
      masterPath: string | null;
      files: Array<{
        assetId: string;
        type: AssetFileType;
        path: string;
        isEdited: boolean;
        isProgressive: boolean;
        isTransparent: boolean;
      }>;
      width: number;
      height: number;
      duration: number;
      thumbhash?: Buffer | null;
    },
  ): Promise<VideoVersionPublication> {
    const refused = { published: false, releasedPaths: [] };
    return this.db.transaction().execute(async (db) => {
      if (!(await this.lockVersionWrites(db))) return refused;
      // Match PhysicalFileRepository's advisory keys, before taking the asset row lock.
      // A retained version cannot race the final reference check in FileDelete.
      const ownedPaths = [result.masterPath, ...result.files.map((file) => file.path)].filter(
        (path): path is string => path !== null,
      );
      for (const path of [...new Set(ownedPaths)].sort()) {
        const key = createHash('sha1').update(path).digest().readBigInt64BE(0);
        await sql`SELECT pg_advisory_xact_lock(${key.toString()}::bigint)`.execute(db);
      }
      const asset = await db
        .selectFrom('asset')
        .select(['ownerId', 'originalPath', 'checksum'])
        .where('id', '=', version.assetId)
        .forUpdate()
        .executeTakeFirst();
      const fail = async () => {
        await sql`UPDATE immich_fork.video_edit_version SET status='failed'
          WHERE id=${version.id}::uuid AND status='pending'`.execute(db);
        return refused;
      };
      if (!asset || asset.ownerId !== version.ownerId || !asset.checksum.equals(version.sourceChecksum)) {
        return fail();
      }
      const proxyPath = result.files.find((file) => file.type === AssetFileType.EncodedVideo)?.path ?? null;
      if (
        ownedPaths.includes(asset.originalPath) ||
        new Set(ownedPaths).size !== ownedPaths.length ||
        result.files.some((file) => file.assetId !== version.assetId || !file.isEdited)
      )
        throw new Error('video_version_invalid_paths');
      const { rows } = await sql<{
        purpose: VideoEditVersion['purpose'];
      }>`UPDATE immich_fork.video_edit_version v SET status='ready',"masterPath"=${result.masterPath},"proxyPath"=${proxyPath},files=${JSON.stringify(result.files)}::text::jsonb
        FROM immich_fork.video_edit_selection s WHERE v.id=${version.id}::uuid AND v.status IN ('pending','failed')
        AND v."assetId"=${version.assetId}::uuid AND v."ownerId"=${version.ownerId}::uuid AND v."sourceChecksum"=${asset.checksum}
        AND s."assetId"=v."assetId" AND s."ownerId"=v."ownerId" AND (s."requestedVersionId"=v.id OR v.purpose='export') RETURNING v.purpose`.execute(
        db,
      );
      // A save or revert that is no longer the requested one is superseded.
      if (rows.length === 0) return fail();
      if (rows[0].purpose === 'export') return { published: true, releasedPaths: [] };
      await sql`UPDATE immich_fork.video_edit_selection SET "currentVersionId"=${version.id}::uuid WHERE "assetId"=${version.assetId}::uuid`.execute(
        db,
      );
      // History owns the paths of earlier versions; replacing the current projection never deletes
      // them. Edited files no version owns (a pre-history edit's proxy, thumbnails and lineage) are
      // released to FileDelete, which checks every remaining reference again under the path lock.
      const previous = await db
        .deleteFrom('asset_file')
        .where('assetId', '=', version.assetId)
        .where('isEdited', '=', true)
        .returning(['path', 'type'])
        .execute();
      const releasedPaths: string[] = [];
      for (const { path, type } of previous) {
        if (ownedPaths.includes(path) || releasedPaths.includes(path)) continue;
        const owned = await sql`SELECT 1 FROM immich_fork.video_edit_version v
          WHERE v."masterPath"=${path} OR v."proxyPath"=${path}
            OR EXISTS(SELECT 1 FROM jsonb_array_elements(v.files) f WHERE f->>'path'=${path}) LIMIT 1`.execute(db);
        if (owned.rows.length > 0) continue;
        releasedPaths.push(path);
        // A pre-history edited master carries its lineage sidecar beside it.
        if (type === AssetFileType.EncodedVideo) releasedPaths.push(getEditedMasterLineagePath(path));
      }
      if (result.files.length > 0) await db.insertInto('asset_file').values(result.files).execute();
      await db
        .updateTable('asset')
        .set({
          width: result.width,
          height: result.height,
          duration: result.duration,
          ...(result.thumbhash !== undefined && { thumbhash: result.thumbhash }),
        })
        .where('id', '=', version.assetId)
        .execute();
      return { published: true, releasedPaths };
    });
  }

  async failVideoVersion(assetId: string, versionId: string): Promise<void> {
    await this.db.transaction().execute(async (db) => {
      if (!(await this.lockVersionWrites(db))) return;
      await sql`UPDATE immich_fork.video_edit_version SET status='failed' WHERE id=${versionId}::uuid AND "assetId"=${assetId}::uuid AND status='pending'`.execute(
        db,
      );
    });
  }

  async listVideoVersions(
    assetId: string,
    ownerId: string,
  ): Promise<Array<VideoEditVersion & { isCurrent: boolean; isRequested: boolean }>> {
    // Only versions of the asset's current original are listed, matching what download, restore
    // and export accept; versions of a replaced original are kept but not offered.
    const { rows } = await sql<
      VideoEditVersion & { isCurrent: boolean; isRequested: boolean }
    >`SELECT ${versionColumns},
      coalesce(s."currentVersionId"=v.id,false) AS "isCurrent", coalesce(s."requestedVersionId"=v.id,false) AS "isRequested"
      FROM immich_fork.video_edit_version v
      LEFT JOIN immich_fork.video_edit_selection s ON s."assetId"=v."assetId" AND s."ownerId"=v."ownerId"
      ${sourceJoin}
      WHERE v."assetId"=${assetId}::uuid AND v."ownerId"=${ownerId}::uuid ORDER BY v."createdAt" DESC,v.id DESC`.execute(
      this.db,
    );
    return rows;
  }

  async getVideoVersion(assetId: string, versionId: string): Promise<VideoEditVersion | undefined> {
    const { rows } = await sql<VideoEditVersion>`SELECT ${versionColumns} FROM immich_fork.video_edit_version v
      ${sourceJoin}
      WHERE v."assetId"=${assetId}::uuid AND v.id=${versionId}::uuid`.execute(this.db);
    return rows[0];
  }

  async createVideoExport(assetId: string, ownerId: string): Promise<VideoEditVersion> {
    return this.db.transaction().execute(async (db) => {
      if (!(await this.lockVersionWrites(db))) throw new Error('video_version_inactive');
      const asset = await db
        .selectFrom('asset')
        .select('id')
        .where('id', '=', assetId)
        .where('ownerId', '=', ownerId)
        .forUpdate()
        .executeTakeFirst();
      if (!asset) throw new Error('video_version_not_found');
      const { rows } = await sql<VideoEditVersion>`INSERT INTO immich_fork.video_edit_version
        ("assetId","ownerId","sourcePath","sourceChecksum",recipe,purpose)
        SELECT v."assetId",v."ownerId",a."originalPath",v."sourceChecksum",v.recipe,'export'
        FROM immich_fork.video_edit_selection s JOIN immich_fork.video_edit_version v ON v.id=s."currentVersionId"
        ${sourceJoin}
        WHERE s."assetId"=${assetId}::uuid AND s."ownerId"=${ownerId}::uuid AND v.status='ready' RETURNING *`.execute(
        db,
      );
      if (!rows[0]) throw new Error('video_version_not_ready');
      return rows[0];
    });
  }

  async pruneVideoVersion(assetId: string, versionId: string, ownerId: string): Promise<string[]> {
    return this.db.transaction().execute(async (db) => {
      if (!(await this.lockVersionWrites(db))) throw new Error('video_version_inactive');
      const asset = await db
        .selectFrom('asset')
        .select('id')
        .where('id', '=', assetId)
        .where('ownerId', '=', ownerId)
        .forUpdate()
        .executeTakeFirst();
      if (!asset) throw new Error('video_version_not_found');
      const { rows } = await sql<VideoEditVersion>`DELETE FROM immich_fork.video_edit_version v
        WHERE v.id=${versionId}::uuid AND v."assetId"=${assetId}::uuid AND v."ownerId"=${ownerId}::uuid
        AND NOT EXISTS(SELECT 1 FROM immich_fork.video_edit_selection s WHERE s."currentVersionId"=v.id OR s."requestedVersionId"=v.id) RETURNING *`.execute(
        db,
      );
      if (!rows[0]) throw new Error('video_version_selected_or_missing');
      const paths = new Set(
        [rows[0].masterPath, ...rows[0].files.map((file) => file.path)].filter((value): value is string => !!value),
      );
      const unreferenced: string[] = [];
      for (const path of paths) {
        const retained =
          await sql`SELECT 1 FROM immich_fork.video_edit_version v WHERE v."masterPath"=${path} OR v."proxyPath"=${path}
          OR EXISTS(SELECT 1 FROM jsonb_array_elements(v.files) f WHERE f->>'path'=${path})
          UNION ALL SELECT 1 FROM public.asset WHERE "originalPath"=${path}
          UNION ALL SELECT 1 FROM public.asset_file WHERE path=${path} LIMIT 1`.execute(db);
        if (retained.rows.length === 0) unreferenced.push(path);
      }
      // The lineage sidecar belongs to its master and leaves with it.
      if (rows[0].masterPath && unreferenced.includes(rows[0].masterPath)) {
        unreferenced.push(getEditedMasterLineagePath(rows[0].masterPath));
      }
      return unreferenced;
    });
  }

  /**
   * Reclaims versions whose asset no longer exists (FL-39): rows left behind while fork writes were
   * disabled, and rows archived to `orphaned_records` by a handoff return. Returns every file they
   * owned, for FileDelete to remove once nothing else references it. Does nothing, and returns
   * nothing, while fork writes are disabled or a handoff is running.
   */
  async releaseOrphanedVideoVersions(): Promise<string[]> {
    return this.db.transaction().execute(async (db) => {
      try {
        if (!(await this.lockVersionWrites(db))) return [];
      } catch {
        return [];
      }
      // A selection shares its versions' asset and owner (composite foreign keys), so it goes first.
      await sql`DELETE FROM immich_fork.video_edit_selection s
        WHERE NOT EXISTS(SELECT 1 FROM public.asset a WHERE a.id=s."assetId" AND a."ownerId"=s."ownerId")`.execute(db);
      const orphanedVersions = await sql<Pick<VideoEditVersion, 'masterPath' | 'proxyPath' | 'files'>>`
        DELETE FROM immich_fork.video_edit_version v
        WHERE NOT EXISTS(SELECT 1 FROM public.asset a WHERE a.id=v."assetId" AND a."ownerId"=v."ownerId")
        RETURNING v."masterPath", v."proxyPath", v.files`.execute(db);
      const archived = await sql<Pick<VideoEditVersion, 'masterPath' | 'proxyPath' | 'files'>>`
        DELETE FROM immich_fork.orphaned_records o
        WHERE o."sourceTable"='video_edit_version'
          AND NOT EXISTS(SELECT 1 FROM public.asset a WHERE a.id::text=o.payload->>'assetId')
        RETURNING o.payload->>'masterPath' AS "masterPath", o.payload->>'proxyPath' AS "proxyPath",
          coalesce(o.payload->'files', '[]'::jsonb) AS files`.execute(db);
      await sql`DELETE FROM immich_fork.orphaned_records o
        WHERE o."sourceTable"='video_edit_selection'
          AND NOT EXISTS(SELECT 1 FROM public.asset a WHERE a.id::text=o.payload->>'assetId')`.execute(db);
      return [
        ...new Set(
          [...orphanedVersions.rows, ...archived.rows]
            .flatMap((version) => versionPaths(version))
            .filter((path): path is string => !!path),
        ),
      ];
    });
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getAll(assetId: string): Promise<AssetEditActionItemResponseDto[]> {
    return this.db
      .selectFrom('asset_edit')
      .select(['id', 'action', 'parameters'])
      .where('assetId', '=', assetId)
      .orderBy('sequence', 'asc')
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getWithSyncInfo(assetId: string) {
    return this.db
      .selectFrom('asset_edit')
      .select(columns.syncAssetEdit)
      .where('assetId', '=', assetId)
      .orderBy('sequence', 'asc')
      .execute();
  }
}
