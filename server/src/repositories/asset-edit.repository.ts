import { BadRequestException, Injectable } from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash } from 'node:crypto';
import type { SourceReference } from 'src/utils/source-reference.js';
import { columns } from 'src/database.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AssetEditActionItem, AssetEditActionItemResponseDto } from 'src/dtos/editing.dto.js';
import { AssetFileType, AssetStatus, AssetType, ChecksumAlgorithm, QueueName, UserStatus } from 'src/enum.js';
import { publicationDatabase } from 'src/queue/transaction.js';
import { lockFilePath } from 'src/repositories/physical-file.repository.js';
import { DB } from 'src/schema/index.js';
import {
  AssetSourceChangedError,
  type AssetSourceSnapshot,
  withAssetSource,
} from 'src/utils/asset-source-authority.js';
import { getEditedMasterLineagePath } from 'src/utils/media-policy.js';
import { lockSourceAuthorities } from 'src/utils/source-authority-lock.js';
import { parseSourceOriginalPath } from 'src/utils/source-original.js';

export type AssetEditSource = { ownerId: string; path: string; checksum: Buffer; reference: SourceReference };
type EditAuthority = { sourceId: string; ownerId: string; path: string; type: AssetType };

export type VideoEditVersion = {
  id: string;
  assetId: string;
  ownerId: string;
  /** Current managed path, or the logical locator of the pinned reference resource. */
  sourcePath: string;
  sourceChecksum: Buffer;
  /** Null for managed files; a reference version must retain its exact verified resource identity. */
  sourceReference: SourceReference | null;
  recipe: AssetEditActionItem[];
  purpose: 'save' | 'export' | 'revert';
  status: 'pending' | 'ready' | 'failed';
  masterPath: string | null;
  proxyPath: string | null;
  files: Array<{
    path: string;
  }>;
  createdAt: Date;
};
export type VideoVersionPublication = {
  published: boolean;
  /** A newer requested version refused this otherwise valid publication. */
  superseded?: boolean;
  /** Edited files the publication dropped from the asset that no retained version owns. */
  releasedPaths: string[];
};
/**
 * A retained version belongs to its asset's original by asset, owner and content checksum. The path
 * is deliberately not part of that identity: physical deduplication and the storage template may
 * move an original, and a version stays valid across the move. The current path is reported as
 * `sourcePath`. References additionally pin their logical locator and verified resource snapshot.
 */
const versionColumns = sql`v.id, v."assetId", v."ownerId", a."originalPath" AS "sourcePath", v."sourceChecksum", v."sourceReference",
  v.recipe, v.purpose, v.status, v."masterPath", v."proxyPath", v.files, v."createdAt"`;
const referenceSnapshot = sql`(SELECT jsonb_build_object('resourceId', r.id, 'version', r.version, 'sha256', encode(r.checksum, 'hex'))
  FROM source_original b JOIN photo_source_resource r ON r.id=b."resourceId" AND r."assetId"=a.id
  JOIN photo_source_run run ON run.id=r."runId" JOIN photo_source s ON s.id=run."sourceId" AND s."ownerId"=a."ownerId"
  WHERE b."assetId"=a.id AND r.state='verified' AND r."verifiedAt" IS NOT NULL
    AND a."originalPath"='frameleaf-source://' || s.id::text || '/' || r."resourceKey")`;
const sourceMatches = sql`a.checksum=v."sourceChecksum" AND CASE WHEN a."originalPath" ILIKE 'frameleaf-source:%'
  THEN v."sourceReference" IS NOT NULL AND v."sourcePath"=a."originalPath" AND v."sourceReference"=${referenceSnapshot}
  ELSE v."sourceReference" IS NULL AND v."sourcePath" NOT ILIKE 'frameleaf-source:%' END`;
const sourceJoin = sql`JOIN public.asset a ON a.id=v."assetId" AND a."ownerId"=v."ownerId" AND ${sourceMatches}`;
const versionPaths = (version: Pick<VideoEditVersion, 'masterPath' | 'proxyPath' | 'files'>) => [
  version.masterPath,
  version.masterPath && getEditedMasterLineagePath(version.masterPath),
  version.proxyPath,
  ...(version.files ?? []).map((file) => file.path),
];
@Injectable()
export class AssetEditRepository {
  constructor(
    @InjectKysely()
    private db: Kysely<DB>,
  ) {
    this.db = publicationDatabase(db);
  }
  private async lockEditAuthority(db: Transaction<DB>, assetId: string): Promise<EditAuthority | undefined> {
    const asset = await db
      .selectFrom('asset')
      .select(['ownerId', 'originalPath', 'type'])
      .where('id', '=', assetId)
      .executeTakeFirst();
    if (!asset) return;
    const identity = parseSourceOriginalPath(asset.originalPath);
    if (!identity) return;
    if (!(await lockSourceAuthorities(db, [{ sourceId: identity.sourceId, ownerId: asset.ownerId }])))
      throw new Error(asset.type === AssetType.Video ? 'video_version_source_changed' : 'asset_edit_source_changed');
    return { sourceId: identity.sourceId, ownerId: asset.ownerId, path: asset.originalPath, type: asset.type };
  }

  private async assertEditAuthority(db: Transaction<DB>, assetId: string, authority?: EditAuthority) {
    if (!authority) {
      const asset = await db
        .selectFrom('asset')
        .select(['originalPath', 'type'])
        .where('id', '=', assetId)
        .executeTakeFirst();
      if (!asset || !parseSourceOriginalPath(asset.originalPath)) return;
      throw new Error(asset.type === AssetType.Video ? 'video_version_source_changed' : 'asset_edit_source_changed');
    }
    const { rows } = await sql`SELECT a.id FROM asset a
      JOIN source_original b ON b."assetId"=a.id
      JOIN photo_source_resource r ON r.id=b."resourceId" AND r."assetId"=a.id
      JOIN photo_source_run run ON run.id=r."runId"
      JOIN photo_source s ON s.id=run."sourceId" AND s."ownerId"=a."ownerId"
      JOIN library l ON l.id=a."libraryId" AND l."ownerId"=s."ownerId"
      JOIN desktop_device d ON d.id=s."deviceId" AND d."userId"=s."ownerId"
      JOIN session p ON p.id=s."photoSessionId" AND p."userId"=s."ownerId"
      JOIN "user" owner ON owner.id=s."ownerId"
      WHERE a.id=${assetId}::uuid AND a."ownerId"=${authority.ownerId}::uuid AND a."originalPath"=${authority.path}
        AND a.type=${authority.type} AND a.status=${AssetStatus.Active} AND a."deletedAt" IS NULL AND a."isExternal"
        AND a."checksumAlgorithm"=${ChecksumAlgorithm.sha1Path} AND s.id=${authority.sourceId}::uuid
        AND a."originalPath"='frameleaf-source://' || s.id::text || '/' || r."resourceKey"
        AND l."readOnly" AND l."deletedAt" IS NULL AND r.state='verified' AND r."verifiedAt" IS NOT NULL
        AND s.mode='reference' AND s."revokedAt" IS NULL AND owner."deletedAt" IS NULL
        AND b."scopeFingerprint"=s."scopeFingerprint" AND b."authorizationEpoch"=d."authorizationEpoch"
        AND d."revokedAt" IS NULL AND d.state NOT IN ('paused','revoked')
        AND (p."expiresAt" IS NULL OR p."expiresAt">clock_timestamp())`.execute(db);
    if (!rows[0])
      throw new Error(
        authority.type === AssetType.Video ? 'video_version_source_changed' : 'asset_edit_source_changed',
      );
  }

  private async lockSourceReference(db: Transaction<DB>, assetId: string) {
    await sql`SELECT b."assetId" FROM source_original b JOIN photo_source_resource r ON r.id=b."resourceId"
      WHERE b."assetId"=${assetId}::uuid FOR SHARE OF b,r`.execute(db);
  }
  @GenerateSql({ params: [DummyValue.UUID] })
  replaceAll(
    assetId: string,
    edits: AssetEditActionItem[],
    purpose: 'save' | 'revert' = 'save',
    expected?: AssetEditSource,
  ): Promise<AssetEditActionItemResponseDto[]> {
    const execute = async (trx: Transaction<DB>) => {
      const authority = await this.lockEditAuthority(trx, assetId);
      // Only video edits are versioned; a photo edit never waits on the fork schema's write phase.
      const target = await trx
        .selectFrom('asset')
        .select('type')
        .where('id', '=', assetId)
        .where('deletedAt', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!target) throw new BadRequestException('Edit source asset is no longer available');
      if (target?.type === AssetType.Video) {
        await this.recordVideoVersion(trx, assetId, edits, purpose, expected);
      } else if (expected) {
        await this.lockSourceReference(trx, assetId);
        const { rows } = await sql`SELECT a.id FROM asset a WHERE a.id=${assetId}::uuid
          AND a."ownerId"=${expected.ownerId}::uuid AND a."originalPath"=${expected.path} AND a.checksum=${expected.checksum}
          AND ${referenceSnapshot}=${JSON.stringify(expected.reference)}::text::jsonb`.execute(trx);
        if (!rows[0]) throw new Error('asset_edit_source_changed');
      }
      await trx.deleteFrom('asset_edit').where('assetId', '=', assetId).execute();
      let result: AssetEditActionItemResponseDto[] = [];
      if (edits.length > 0) {
        result = await trx
          .insertInto('asset_edit')
          .values(
            edits.map((edit, i) => ({
              assetId,
              sequence: i,
              ...edit,
              sourceReference: target.type === AssetType.Image ? (expected?.reference ?? null) : null,
            })),
          )
          .returning(['id', 'action', 'parameters'])
          .execute();
      }
      await this.assertEditAuthority(trx, assetId, authority);
      return result;
    };
    return this.db.isTransaction ? execute(this.db as Transaction<DB>) : this.db.transaction().execute(execute);
  }

  async sourceProjectionAssetIds(source: Pick<AssetSourceSnapshot, 'assetId' | 'ownerId'>): Promise<string[]> {
    const { rows } = await sql<{ assetId: string }>`SELECT r."assetId" FROM public.asset_develop_revision r
      JOIN asset a ON a.id=r."assetId" AND a."ownerId"=${source.ownerId}::uuid
      WHERE r."ownerId"=${source.ownerId}::uuid AND r."isCurrent" AND r."sourceAssetId"=${source.assetId}::uuid`.execute(
      this.db,
    );
    return [...new Set([source.assetId, ...rows.map(({ assetId }) => assetId)])].sort();
  }

  /** Retire current projections in the source-version transaction; retained recipes and outputs remain history. */
  retireSourceProjection(
    expected: AssetSourceSnapshot,
    admit: (tx: Transaction<DB>, result: { paths: string[]; assetIds: string[] }) => Promise<void>,
  ): Promise<{ paths: string[]; assetIds: string[] }> {
    if (expected.derivatives) throw new AssetSourceChangedError();
    const execute = async (tx: Transaction<DB>) => {
      await sql`SELECT name FROM job_queue WHERE name=${QueueName.BackgroundTask} FOR NO KEY UPDATE`.execute(tx);
      const owner = await tx
        .selectFrom('user')
        .select('id')
        .where('id', '=', expected.ownerId)
        .where('deletedAt', 'is', null)
        .where('status', '=', UserStatus.Active)
        .forShare()
        .executeTakeFirst();
      if (!owner) throw new AssetSourceChangedError();
      const repository = new AssetEditRepository(tx);
      const lockedIds = await repository.sourceProjectionAssetIds(expected);
      const files = (ids: string[]) =>
        tx.selectFrom('asset_file').select('path').where('assetId', 'in', ids).where('isEdited', '=', true).execute();
      const lockedPaths = new Set((await files(lockedIds)).map(({ path }) => path));
      for (const path of [...lockedPaths].sort()) await lockFilePath(tx, path);
      // The parent and all selected motion dependents share the same asset-row lock order as rendering.
      await tx
        .selectFrom('asset')
        .select('id')
        .where('id', 'in', lockedIds)
        .where('ownerId', '=', expected.ownerId)
        .orderBy('id')
        .forUpdate()
        .execute();
      return withAssetSource(tx, expected, 'update', async () => {
        const assetIds = await repository.sourceProjectionAssetIds(expected);
        if (assetIds.some((id) => !lockedIds.includes(id))) throw new AssetSourceChangedError();
        if ((await files(assetIds)).some(({ path }) => !lockedPaths.has(path))) throw new AssetSourceChangedError();
        // Retained rows are inactive history, but existing sync clients still need deletion facts.
        await sql`INSERT INTO asset_edit_audit ("editId", "assetId")
          SELECT e.id, e."assetId" FROM asset_edit e JOIN asset a ON a.id=e."assetId"
          WHERE a."isEdited" AND a.id=ANY(${assetIds}::uuid[])`.execute(tx);
        await sql`UPDATE public.asset_develop_revision SET "isCurrent"=false, "updatedAt"=now()
          WHERE "assetId"=ANY(${assetIds}::uuid[]) AND "ownerId"=${expected.ownerId}::uuid AND "isCurrent"`.execute(tx);
        await sql`DELETE FROM public.video_edit_selection WHERE "assetId"=ANY(${assetIds}::uuid[])
          AND "ownerId"=${expected.ownerId}::uuid`.execute(tx);
        const removed = await tx
          .deleteFrom('asset_file')
          .where('assetId', 'in', assetIds)
          .where('isEdited', '=', true)
          .returning('path')
          .execute();
        await tx
          .updateTable('asset')
          .set({ isEdited: false, width: null, height: null, thumbhash: null })
          .where('id', 'in', assetIds)
          .where('ownerId', '=', expected.ownerId)
          .execute();
        const result = { paths: [...new Set(removed.map(({ path }) => path))].sort(), assetIds };
        await admit(tx, result);
        return result;
      });
    };
    return this.db.isTransaction ? execute(this.db as Transaction<DB>) : this.db.transaction().execute(execute);
  }

  /** A mutable still recipe may render only the exact reference its owner saved. */
  async assertImageEditSource(assetId: string): Promise<void> {
    const { rows } = await sql`SELECT a.id FROM asset a WHERE a.id=${assetId}::uuid AND a.type=${AssetType.Image}
      AND NOT EXISTS (SELECT 1 FROM asset_edit e WHERE e."assetId"=a.id AND CASE
        WHEN a."originalPath" ILIKE 'frameleaf-source:%' THEN
          e."sourceReference" IS NULL OR e."sourceReference" IS DISTINCT FROM ${referenceSnapshot}
        ELSE e."sourceReference" IS NOT NULL END) FOR SHARE OF a`.execute(this.db);
    if (!rows[0]) throw new Error('asset_edit_source_changed');
  }

  private async recordVideoVersion(
    db: Transaction<DB>,
    assetId: string,
    recipe: AssetEditActionItem[],
    purpose: 'save' | 'revert',
    expected?: AssetEditSource,
  ) {
    const asset = await db
      .selectFrom('asset')
      .select(['id', 'ownerId', 'originalPath', 'checksum', 'type'])
      .where('id', '=', assetId)
      .forUpdate()
      .executeTakeFirst();
    if (!asset || asset.type !== AssetType.Video) return;
    await this.lockSourceReference(db, assetId);
    const { rows: snapshots } = await sql<{
      reference: SourceReference | null;
    }>`SELECT ${referenceSnapshot} AS reference
      FROM asset a WHERE a.id=${assetId}::uuid`.execute(db);
    const sourceReference = snapshots[0]?.reference ?? null;
    if (
      expected &&
      (asset.ownerId !== expected.ownerId ||
        asset.originalPath !== expected.path ||
        !asset.checksum.equals(expected.checksum) ||
        !sourceReference ||
        sourceReference.resourceId !== expected.reference.resourceId ||
        sourceReference.version !== expected.reference.version ||
        sourceReference.sha256 !== expected.reference.sha256)
    )
      throw new Error('video_version_source_changed');

    if (parseSourceOriginalPath(asset.originalPath) && !sourceReference)
      throw new BadRequestException('Edit source resource is no longer available');
    // A pending save or revert that is superseded before it renders will never be published.
    await sql`UPDATE public.video_edit_version v SET status='failed'
      FROM public.video_edit_selection s
      WHERE s."assetId"=${asset.id}::uuid AND v.id=s."requestedVersionId" AND v.status='pending'`.execute(db);
    const { rows } = await sql<VideoEditVersion>`INSERT INTO public.video_edit_version
      ("assetId","ownerId","sourcePath","sourceChecksum","sourceReference",recipe,purpose)
      VALUES(${asset.id}::uuid,${asset.ownerId}::uuid,${asset.originalPath},${asset.checksum},${sourceReference ? JSON.stringify(sourceReference) : null}::text::jsonb,${JSON.stringify(recipe)}::text::jsonb,${purpose}) RETURNING *`.execute(
      db,
    );
    await sql`INSERT INTO public.video_edit_selection ("assetId","ownerId","requestedVersionId")
      VALUES(${asset.id}::uuid,${asset.ownerId}::uuid,${rows[0].id}::uuid)
      ON CONFLICT ("assetId") DO UPDATE SET "requestedVersionId"=excluded."requestedVersionId"`.execute(db);
  }
  async getRequestedVideoVersion(assetId: string): Promise<VideoEditVersion | undefined> {
    const { rows } = await sql<VideoEditVersion>`SELECT ${versionColumns} FROM public.video_edit_selection s
      JOIN public.video_edit_version v ON v.id=s."requestedVersionId"
      ${sourceJoin}
      WHERE s."assetId"=${assetId}::uuid`.execute(this.db);
    if (!rows[0]) {
      const retained = await sql`SELECT 1 FROM public.video_edit_selection WHERE "assetId"=${assetId}::uuid`.execute(
        this.db,
      );
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
      const authority = await this.lockEditAuthority(db, version.assetId);
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
        await sql`UPDATE public.video_edit_version SET status='failed'
          WHERE id=${version.id}::uuid AND status='pending'`.execute(db);
        return refused;
      };
      if (!asset || asset.ownerId !== version.ownerId || !asset.checksum.equals(version.sourceChecksum)) return fail();
      await this.assertEditAuthority(db, version.assetId, authority);
      await this.lockSourceReference(db, version.assetId);
      const { rows: sources } = await sql`SELECT v.id FROM video_edit_version v ${sourceJoin}
        WHERE v.id=${version.id}::uuid AND v."assetId"=${version.assetId}::uuid
          AND v."sourceReference" IS NOT DISTINCT FROM ${version.sourceReference ? JSON.stringify(version.sourceReference) : null}::text::jsonb`.execute(
        db,
      );
      if (!sources[0]) return fail();
      const proxyPath = result.files.find((file) => file.type === AssetFileType.EncodedVideo)?.path ?? null;
      if (
        ownedPaths.includes(asset.originalPath) ||
        new Set(ownedPaths).size !== ownedPaths.length ||
        result.files.some((file) => file.assetId !== version.assetId || !file.isEdited)
      )
        throw new Error('video_version_invalid_paths');
      const { rows } = await sql<{
        purpose: VideoEditVersion['purpose'];
      }>`UPDATE public.video_edit_version v SET status='ready',"masterPath"=${result.masterPath},"proxyPath"=${proxyPath},files=${JSON.stringify(result.files)}::text::jsonb
        FROM public.video_edit_selection s WHERE v.id=${version.id}::uuid AND v.status IN ('pending','failed')
        AND v."assetId"=${version.assetId}::uuid AND v."ownerId"=${version.ownerId}::uuid AND v."sourceChecksum"=${asset.checksum}
        AND s."assetId"=v."assetId" AND s."ownerId"=v."ownerId" AND (s."requestedVersionId"=v.id OR v.purpose='export') RETURNING v.purpose`.execute(
        db,
      );
      // A save or revert that is no longer the requested one is superseded.
      if (rows.length === 0) {
        const { rows: selections } = await sql<{ superseded: boolean }>`SELECT EXISTS (
          SELECT 1 FROM public.video_edit_selection s JOIN public.video_edit_version v ON v."assetId"=s."assetId"
          WHERE v.id=${version.id}::uuid AND v."assetId"=${version.assetId}::uuid
            AND v."ownerId"=${version.ownerId}::uuid AND v."sourceChecksum"=${asset.checksum}
            AND v.purpose IN ('save','revert') AND s."ownerId"=v."ownerId"
            AND s."requestedVersionId" IS DISTINCT FROM v.id
        ) AS superseded`.execute(db);
        return { ...(await fail()), ...(selections[0].superseded && { superseded: true }) };
      }
      if (rows[0].purpose === 'export') {
        await this.assertEditAuthority(db, version.assetId, authority);
        return { published: true, releasedPaths: [] };
      }
      await sql`UPDATE public.video_edit_selection SET "currentVersionId"=${version.id}::uuid WHERE "assetId"=${version.assetId}::uuid`.execute(
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
        const owned = await sql`SELECT 1 FROM public.video_edit_version v
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
      await this.assertEditAuthority(db, version.assetId, authority);
      return { published: true, releasedPaths };
    });
  }
  async failVideoVersion(assetId: string, versionId: string): Promise<void> {
    await this.db.transaction().execute(async (db) => {
      await sql`UPDATE public.video_edit_version SET status='failed' WHERE id=${versionId}::uuid AND "assetId"=${assetId}::uuid AND status='pending'`.execute(
        db,
      );
    });
  }
  async listVideoVersions(
    assetId: string,
    ownerId: string,
  ): Promise<
    Array<
      VideoEditVersion & {
        isCurrent: boolean;
        isRequested: boolean;
      }
    >
  > {
    // Only versions of the asset's current original are listed, matching what download, restore
    // and export accept; versions of a replaced original are kept but not offered.
    const { rows } = await sql<
      VideoEditVersion & {
        isCurrent: boolean;
        isRequested: boolean;
      }
    >`SELECT ${versionColumns},
      coalesce(s."currentVersionId"=v.id,false) AS "isCurrent", coalesce(s."requestedVersionId"=v.id,false) AS "isRequested"
      FROM public.video_edit_version v
      LEFT JOIN public.video_edit_selection s ON s."assetId"=v."assetId" AND s."ownerId"=v."ownerId"
      ${sourceJoin}
      WHERE v."assetId"=${assetId}::uuid AND v."ownerId"=${ownerId}::uuid ORDER BY v."createdAt" DESC,v.id DESC`.execute(
      this.db,
    );
    return rows;
  }
  async getVideoVersion(assetId: string, versionId: string): Promise<VideoEditVersion | undefined> {
    const { rows } = await sql<VideoEditVersion>`SELECT ${versionColumns} FROM public.video_edit_version v
      ${sourceJoin}
      WHERE v."assetId"=${assetId}::uuid AND v.id=${versionId}::uuid`.execute(this.db);
    return rows[0];
  }
  async createVideoExport(assetId: string, ownerId: string): Promise<VideoEditVersion> {
    return this.db.transaction().execute(async (db) => {
      const authority = await this.lockEditAuthority(db, assetId);
      const asset = await db
        .selectFrom('asset')
        .select('id')
        .where('id', '=', assetId)
        .where('ownerId', '=', ownerId)
        .forUpdate()
        .executeTakeFirst();
      if (!asset) throw new Error('video_version_not_found');
      await this.assertEditAuthority(db, assetId, authority);
      await this.lockSourceReference(db, assetId);
      const { rows } = await sql<VideoEditVersion>`INSERT INTO public.video_edit_version
        ("assetId","ownerId","sourcePath","sourceChecksum","sourceReference",recipe,purpose)
        SELECT v."assetId",v."ownerId",a."originalPath",v."sourceChecksum",v."sourceReference",v.recipe,'export'
        FROM public.video_edit_selection s JOIN public.video_edit_version v ON v.id=s."currentVersionId"
        ${sourceJoin}
        WHERE s."assetId"=${assetId}::uuid AND s."ownerId"=${ownerId}::uuid AND v.status='ready' RETURNING *`.execute(
        db,
      );
      if (!rows[0]) throw new Error('video_version_not_ready');
      await this.assertEditAuthority(db, assetId, authority);
      return rows[0];
    });
  }
  async pruneVideoVersion(assetId: string, versionId: string, ownerId: string): Promise<string[]> {
    return this.db.transaction().execute(async (db) => {
      const asset = await db
        .selectFrom('asset')
        .select('id')
        .where('id', '=', assetId)
        .where('ownerId', '=', ownerId)
        .forUpdate()
        .executeTakeFirst();
      if (!asset) throw new Error('video_version_not_found');
      const { rows } = await sql<VideoEditVersion>`DELETE FROM public.video_edit_version v
        WHERE v.id=${versionId}::uuid AND v."assetId"=${assetId}::uuid AND v."ownerId"=${ownerId}::uuid
        AND NOT EXISTS(SELECT 1 FROM public.video_edit_selection s WHERE s."currentVersionId"=v.id OR s."requestedVersionId"=v.id) RETURNING *`.execute(
        db,
      );
      if (!rows[0]) throw new Error('video_version_selected_or_missing');
      const paths = new Set(
        [rows[0].masterPath, ...rows[0].files.map((file) => file.path)].filter((value): value is string => !!value),
      );
      const unreferenced: string[] = [];
      for (const path of paths) {
        const retained =
          await sql`SELECT 1 FROM public.video_edit_version v WHERE v."masterPath"=${path} OR v."proxyPath"=${path}
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
   * Reclaims versions whose asset no longer exists. Returns files for FileDelete to remove
   * only after checking that nothing else references them.
   */
  async releaseOrphanedVideoVersions(): Promise<string[]> {
    return this.db.transaction().execute(async (db) => {
      // A selection shares its versions' asset and owner (composite foreign keys), so it goes first.
      await sql`DELETE FROM public.video_edit_selection s
        WHERE NOT EXISTS(SELECT 1 FROM public.asset a WHERE a.id=s."assetId" AND a."ownerId"=s."ownerId")`.execute(db);
      const orphanedVersions = await sql<Pick<VideoEditVersion, 'masterPath' | 'proxyPath' | 'files'>>`
        DELETE FROM public.video_edit_version v
        WHERE NOT EXISTS(SELECT 1 FROM public.asset a WHERE a.id=v."assetId" AND a."ownerId"=v."ownerId")
        RETURNING v."masterPath", v."proxyPath", v.files`.execute(db);

      return [
        ...new Set(
          [...orphanedVersions.rows]
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
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('asset')
            .select('id')
            .whereRef('asset.id', '=', 'asset_edit.assetId')
            .where('isEdited', '=', true),
        ),
      )
      .orderBy('sequence', 'asc')
      .execute();
  }
  @GenerateSql({ params: [DummyValue.UUID] })
  getWithSyncInfo(assetId: string) {
    return this.db
      .selectFrom('asset_edit')
      .select(columns.syncAssetEdit)
      .where('assetId', '=', assetId)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('asset')
            .select('id')
            .whereRef('asset.id', '=', 'asset_edit.assetId')
            .where('isEdited', '=', true),
        ),
      )
      .orderBy('sequence', 'asc')
      .execute();
  }
}
