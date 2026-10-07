import { Injectable } from '@nestjs/common';
import { type Insertable, type Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { EXTERNAL_SCAN_CHECKSUM } from 'src/constants.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetFileType, AssetStatus, ChecksumAlgorithm, IntegrityReport } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { IntegrityReportTable } from 'src/schema/tables/integrity-report.table.js';
import { IntegrityVerificationResult } from 'src/schema/tables/safety-proof.table.js';
import { isMotionOfLockedStill, withHiddenContentFilter } from 'src/utils/database.js';
import { isNotLocked } from 'src/utils/locked.js';

export type ReportPaginationOptions = {
  cursor?: string;
  limit: number;
};
@Injectable()
export class IntegrityRepository {
  constructor(
    @InjectKysely()
    private db: Kysely<DB>,
  ) {}
  /** Current own library only, using the owner-access lock and hidden-content predicates. */
  getSafetyQuery(auth: AuthDto, hashes?: string[]) {
    const privacy = auth.hiddenContent ?? auth.hideNsfwAssets;
    return this.getOwnedOriginalSafetyQuery(auth.user.id, hashes)
      .$if(!auth.session?.hasElevatedPermission, (qb) =>
        qb.where(isNotLocked('asset')).where((eb) => eb.not(isMotionOfLockedStill(eb))),
      )
      .$call((qb) =>
        withHiddenContentFilter(
          qb,
          typeof privacy === 'object' ? { hiddenContent: privacy } : privacy ? { excludeNsfw: true } : {},
        ),
      );
  }

  /** Structural ownership/content query only. Callers must apply their actual privacy authority. */
  getOwnedOriginalSafetyQuery(ownerId: string, hashes?: string[]) {
    const sha256 = sql<string | null>`CASE
      WHEN asset."checksumAlgorithm" = ${ChecksumAlgorithm.sha256File} THEN encode(asset.checksum, 'hex')
      WHEN asset."checksumAlgorithm" = ${ChecksumAlgorithm.sha1File} THEN (
        SELECT encode(c.sha256, 'hex') FROM public.asset_checksum c
        WHERE c."assetId" = asset.id AND c.sha1 = asset.checksum
          AND asset."originalPath" = ANY(c."verifiedPaths")
      )
      WHEN asset."checksumAlgorithm" = ${ChecksumAlgorithm.sha1Path} THEN (
        SELECT encode(c.sha256, 'hex') FROM public.asset_checksum c
        WHERE c."assetId" = asset.id AND asset."originalPath" = ANY(c."verifiedPaths")
          AND c.evidence ->> 'source' IN (${EXTERNAL_SCAN_CHECKSUM}, 'recovery')
      ) ELSE NULL END`;
    return this.db
      .selectFrom('asset')
      .leftJoin('library', 'library.id', 'asset.libraryId')
      .leftJoin('asset_integrity_verification as integrity', (join) =>
        join
          .onRef('integrity.assetId', '=', 'asset.id')
          .onRef('integrity.originalPath', '=', 'asset.originalPath')
          .onRef('integrity.expectedChecksum', '=', 'asset.checksum')
          .on(sql<boolean>`integrity."checksumAlgorithm" IS NOT DISTINCT FROM asset."checksumAlgorithm"::text`),
      )
      .where('asset.ownerId', '=', ownerId)
      .where('asset.deletedAt', 'is', null)
      .where('asset.status', '=', AssetStatus.Active)
      .where('library.deletedAt', 'is', null)
      .$if(hashes !== undefined, (qb) => qb.where(sha256, 'in', hashes!))
      .select([
        'asset.id',
        'asset.createdAt as onServerSince',
        'asset.isOffline',
        'integrity.checkedAt as lastIntegrityAt',
        'integrity.result as integrityResult',
        sha256.as('sha256'),
      ]);
  }
  /** Guard the attempted identity while publishing; a replaced original cannot inherit this outcome. */
  @GenerateSql({
    params: [
      {
        assetId: DummyValue.UUID,
        originalPath: DummyValue.STRING,
        expectedChecksum: DummyValue.BUFFER,
        checksumAlgorithm: 'sha256-file',
        actualSha256: DummyValue.STRING,
        result: 'passed',
      },
    ],
  })
  async recordVerification(input: {
    assetId: string;
    originalPath: string;
    expectedChecksum: Buffer;
    checksumAlgorithm: string | null;
    actualSha256: string | null;
    result: IntegrityVerificationResult;
  }): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      const current = await tx
        .selectFrom('asset')
        .select(['originalPath', 'checksum', 'checksumAlgorithm'])
        .where('id', '=', input.assetId)
        .forShare()
        .executeTakeFirst();
      if (
        !current ||
        current.originalPath !== input.originalPath ||
        !current.checksum.equals(input.expectedChecksum) ||
        current.checksumAlgorithm !== input.checksumAlgorithm
      ) {
        return false;
      }
      await tx
        .insertInto('asset_integrity_verification')
        .values(input)
        .onConflict((oc) => oc.column('assetId').doUpdateSet({ ...input, checkedAt: sql<Date>`clock_timestamp()` }))
        .execute();
      return true;
    });
  }
  create(dto: Insertable<IntegrityReportTable> | Insertable<IntegrityReportTable>[]) {
    return this.db
      .insertInto('integrity_report')
      .values(dto)
      .onConflict((oc) =>
        oc.columns(['path', 'type']).doUpdateSet({
          assetId: (eb) => eb.ref('excluded.assetId'),
          fileAssetId: (eb) => eb.ref('excluded.fileAssetId'),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  @GenerateSql({ params: [DummyValue.STRING] })
  getById(id: string) {
    return this.db
      .selectFrom('integrity_report')
      .selectAll('integrity_report')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }
  @GenerateSql({ params: [] })
  async getIntegrityReportSummary() {
    const counts = await this.db
      .selectFrom('integrity_report')
      .select(['type', this.db.fn.countAll<number>().as('count')])
      .groupBy('type')
      .execute();
    return Object.fromEntries(
      Object.values(IntegrityReport).map((type) => [type, counts.find((count) => count.type === type)?.count || 0]),
    ) as Record<IntegrityReport, number>;
  }
  @GenerateSql({ params: [{ cursor: DummyValue.NUMBER, limit: 100 }, DummyValue.STRING] })
  async getIntegrityReport(pagination: ReportPaginationOptions, type: IntegrityReport) {
    const items = await this.db
      .selectFrom('integrity_report')
      .select(['id', 'type', 'path', 'assetId', 'fileAssetId', 'createdAt'])
      .where('type', '=', type)
      .$if(pagination.cursor !== undefined, (eb) => eb.where('id', '<=', pagination.cursor!))
      .orderBy('id', 'desc')
      .limit(pagination.limit + 1)
      .execute();
    return {
      items: items.slice(0, pagination.limit),
      nextCursor: items.at(pagination.limit)?.id,
    };
  }
  @GenerateSql({ params: [DummyValue.STRING] })
  getAssetPathsByPaths(paths: string[]) {
    return this.db
      .selectFrom('asset')
      .leftJoin('asset_file', (join) =>
        join.onRef('asset.id', '=', 'asset_file.assetId').on('asset_file.type', '=', AssetFileType.EncodedVideo),
      )
      .select(['asset.originalPath', 'asset_file.path as encodedVideoPath'])
      .where((eb) => eb.or([eb('originalPath', 'in', paths), eb('asset_file.path', 'in', paths)]))
      .execute();
  }
  @GenerateSql({ params: [DummyValue.STRING] })
  getAssetFilePathsByPaths(paths: string[]) {
    return this.db.selectFrom('asset_file').select('path').where('path', 'in', paths).execute();
  }
  @GenerateSql({ params: [DummyValue.STRING] })
  async getVideoDuplicateFramePathsByPaths(paths: string[]) {
    return this.db
      .withSchema('public')
      .selectFrom('asset_video_duplicate_frame')
      .select('path')
      .where('path', 'in', paths)
      .execute();
  }
  /**
   * Edited masters, previews and developed files brought back (FL-113, FL-64) live beside the
   * asset's thumbnails but are tracked by their develop version, not `asset_file`. Retained video
   * versions (FL-39) own their master, its lineage sidecar, proxy and thumbnails the same way, and an
   * edited master in `asset_file` owns its lineage sidecar, and a Studio HDR intermediate (FL-97)
   * is owned by its fork row, as is a develop artifact (FL-233: a client's mask or generated fill,
   * which cannot be regenerated). Without this
   * the untracked-file check would report — and offer to delete — a person's saved edits.
   */
  async getDevelopRevisionPathsByPaths(paths: string[]): Promise<
    {
      path: string;
    }[]
  > {
    if (paths.length === 0) {
      return [];
    }
    const { rows } = await sql<{
      path: string;
    }>`
      SELECT "masterPath" AS path FROM public.asset_develop_revision WHERE "masterPath" IN (${sql.join(paths)})
      UNION
      SELECT "previewPath" AS path FROM public.asset_develop_revision WHERE "previewPath" IN (${sql.join(paths)})
      UNION SELECT "hdrMasterPath" AS path FROM public.asset_develop_revision WHERE "hdrMasterPath" IN (${sql.join(paths)})
      UNION SELECT "hdrPreviewPath" AS path FROM public.asset_develop_revision WHERE "hdrPreviewPath" IN (${sql.join(paths)})
      UNION
      SELECT "masterPath" AS path FROM public.video_edit_version WHERE "masterPath" IN (${sql.join(paths)})
      UNION
      SELECT "proxyPath" AS path FROM public.video_edit_version WHERE "proxyPath" IN (${sql.join(paths)})
      UNION
      SELECT file->>'path' AS path FROM public.video_edit_version version, jsonb_array_elements(version.files) file
      WHERE file->>'path' IN (${sql.join(paths)})
      UNION
      SELECT "masterPath" || '.lineage.json' AS path FROM public.video_edit_version
      WHERE "masterPath" || '.lineage.json' IN (${sql.join(paths)})
      UNION
      SELECT path || '.lineage.json' AS path FROM public.asset_file
      WHERE "isEdited" AND type = 'encoded_video' AND path || '.lineage.json' IN (${sql.join(paths)})
      UNION
      SELECT path FROM public.studio_hdr_intermediate WHERE path IN (${sql.join(paths)})
      UNION
      SELECT path FROM public.asset_develop_artifact WHERE path IN (${sql.join(paths)})
      UNION
      SELECT photo->>'previewPath' AS path FROM public.photography_workflow workflow,
        jsonb_array_elements(COALESCE(workflow.value->'published'->'photos','[]'::jsonb) || COALESCE(workflow.value->'publication'->'photos','[]'::jsonb)) photo
      WHERE photo->>'previewPath' IN (${sql.join(paths)})
      UNION
      SELECT photo->>'thumbnailPath' AS path FROM public.photography_workflow workflow,
        jsonb_array_elements(COALESCE(workflow.value->'published'->'photos','[]'::jsonb) || COALESCE(workflow.value->'publication'->'photos','[]'::jsonb)) photo
      WHERE photo->>'thumbnailPath' IN (${sql.join(paths)})
      UNION
      SELECT item->>'finalPath' AS path FROM public.photography_workflow workflow,
        jsonb_array_elements(workflow.value->'orders') orders,jsonb_array_elements(orders->'items') item
      WHERE item->>'finalPath' IN (${sql.join(paths)})
      UNION
      SELECT output->>'approvalPreviewPath' AS path FROM public.photography_workflow workflow,
      jsonb_array_elements(workflow.value->'orders') orders,jsonb_array_elements(orders->'items') item,
      jsonb_array_elements(COALESCE(item->'outputs','[]'::jsonb)) output
      WHERE output->>'approvalPreviewPath' IN (${sql.join(paths)})
      UNION
      SELECT output->>'finalPath' AS path FROM public.photography_workflow workflow,
      jsonb_array_elements(workflow.value->'orders') orders,jsonb_array_elements(orders->'items') item,
      jsonb_array_elements(COALESCE(item->'outputs','[]'::jsonb)) output
      WHERE output->>'finalPath' IN (${sql.join(paths)})
      UNION
      SELECT workflow.value->'published'->>'logoPath' AS path FROM public.photography_workflow workflow
      WHERE workflow.value->'published'->>'logoPath' IN (${sql.join(paths)})
      UNION
      SELECT workflow.value->'publication'->>'logoPath' AS path FROM public.photography_workflow workflow
      WHERE workflow.value->'publication'->>'logoPath' IN (${sql.join(paths)})
    `.execute(this.db);
    return rows;
  }
  @GenerateSql({ params: [DummyValue.STRING] })
  getPersonThumbnailPathsByPaths(paths: string[]) {
    return this.db
      .selectFrom('person')
      .select('person.thumbnailPath')
      .where('person.thumbnailPath', 'in', paths)
      .execute();
  }
  @GenerateSql({ params: [DummyValue.STRING] })
  async getTrackedPaths(paths: string[]) {
    const tracked = await this.db
      .selectFrom('asset')
      .select('asset.originalPath as path')
      .where('asset.originalPath', 'in', paths)
      .union((eb) =>
        eb.selectFrom('asset_file').select('asset_file.path as path').where('asset_file.path', 'in', paths),
      )
      .union((eb) =>
        eb
          .selectFrom('person')
          .select((eb) => eb.ref('person.thumbnailPath').$castTo<string>().as('path'))
          .where('person.thumbnailPath', 'in', paths),
      )
      .execute();
    return [
      ...tracked,
      ...(await this.getVideoDuplicateFramePathsByPaths(paths)),
      ...(await this.getDevelopRevisionPathsByPaths(paths)),
    ];
  }
  @GenerateSql({ params: [] })
  getAssetCount() {
    return this.db
      .selectFrom('asset')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow();
  }
  @GenerateSql({ params: [], stream: true })
  streamAllAssetPaths() {
    return this.db
      .selectFrom('asset')
      .leftJoin('asset_file', (join) =>
        join.onRef('asset.id', '=', 'asset_file.assetId').on('asset_file.type', '=', AssetFileType.EncodedVideo),
      )
      .select(['originalPath', 'asset_file.path as encodedVideoPath'])
      .stream();
  }
  @GenerateSql({ params: [], stream: true })
  streamAllAssetFilePaths() {
    return this.db.selectFrom('asset_file').select(['path']).stream();
  }
  @GenerateSql({ params: [], stream: true })
  streamAssetPathsForMissingFiles() {
    return this.db
      .selectFrom((eb) =>
        eb
          .selectFrom('asset')
          .where('asset.deletedAt', 'is', null)
          .select('asset.originalPath as path')
          .select((eb) => [
            eb.ref('asset.id').$castTo<string | null>().as('assetId'),
            sql<string | null>`null::uuid`.as('fileAssetId'),
          ])
          .unionAll(
            eb
              .selectFrom('asset_file')
              .select(['path'])
              .select((eb) => [
                sql<string | null>`null::uuid`.as('assetId'),
                eb.ref('asset_file.id').$castTo<string | null>().as('fileAssetId'),
              ]),
          )
          .as('allPaths'),
      )
      .leftJoin('integrity_report', (join) =>
        join
          .on('integrity_report.type', '=', IntegrityReport.MissingFile)
          .on((eb) =>
            eb.or([
              eb('integrity_report.assetId', '=', eb.ref('allPaths.assetId')),
              eb('integrity_report.fileAssetId', '=', eb.ref('allPaths.fileAssetId')),
            ]),
          ),
      )
      .select(['allPaths.path as path', 'allPaths.assetId', 'allPaths.fileAssetId', 'integrity_report.id as reportId'])
      .stream() as AsyncIterableIterator<
      {
        path: string;
        reportId: string | null;
      } & (
        | {
            assetId: string;
            fileAssetId: null;
          }
        | {
            assetId: null;
            fileAssetId: string;
          }
      )
    >;
  }
  @GenerateSql({ params: [DummyValue.DATE], stream: true })
  streamAssetChecksums(startMarker?: Date) {
    return this.db
      .selectFrom('asset')
      .where('asset.deletedAt', 'is', null)
      .leftJoin('integrity_report', (join) =>
        join
          .onRef('integrity_report.assetId', '=', 'asset.id')
          .on('integrity_report.type', '=', IntegrityReport.ChecksumFail),
      )
      .select([
        'asset.originalPath',
        'asset.checksum',
        'asset.checksumAlgorithm',
        'asset.createdAt',
        'asset.id as assetId',
        'integrity_report.id as reportId',
      ])
      .where('asset.isExternal', '=', sql.lit(false))
      .$if(startMarker !== undefined, (qb) => qb.where('asset.createdAt', '>=', startMarker!))
      .orderBy('asset.createdAt', 'asc')
      .stream();
  }
  @GenerateSql({ params: [DummyValue.STRING], stream: true })
  streamIntegrityReports(type: IntegrityReport) {
    return this.db
      .selectFrom('integrity_report')
      .select(['id', 'type', 'path', 'assetId', 'fileAssetId'])
      .where('type', '=', type)
      .orderBy('createdAt', 'desc')
      .stream();
  }
  @GenerateSql({ params: [DummyValue.STRING], stream: true })
  streamIntegrityReportsWithAssetChecksum(type: IntegrityReport) {
    return this.db
      .selectFrom('integrity_report')
      .select(['integrity_report.id as reportId', 'integrity_report.path'])
      .where('integrity_report.type', '=', type)
      .$if(type === IntegrityReport.ChecksumFail, (eb) =>
        eb
          .leftJoin('asset', 'integrity_report.path', 'asset.originalPath')
          .select(['asset.checksum', 'asset.checksumAlgorithm']),
      )
      .stream();
  }
  @GenerateSql({ params: [DummyValue.STRING], stream: true })
  streamIntegrityReportsByProperty(property?: 'assetId' | 'fileAssetId', filterType?: IntegrityReport) {
    return this.db
      .selectFrom('integrity_report')
      .select(['id', 'path', 'assetId', 'fileAssetId'])
      .$if(filterType !== undefined, (eb) => eb.where('type', '=', filterType!))
      .$if(property === undefined, (eb) => eb.where('assetId', 'is', null).where('fileAssetId', 'is', null))
      .$if(property !== undefined, (eb) => eb.where(property!, 'is not', null))
      .stream();
  }
  @GenerateSql({ params: [DummyValue.STRING] })
  deleteById(id: string) {
    return this.db.deleteFrom('integrity_report').where('id', '=', id).execute();
  }
  @GenerateSql({ params: [DummyValue.STRING] })
  deleteByIds(ids: string[]) {
    return this.db.deleteFrom('integrity_report').where('id', 'in', ids).execute();
  }
}
