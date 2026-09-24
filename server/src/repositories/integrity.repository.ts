import { Injectable } from '@nestjs/common';
import { type Insertable, type Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AssetFileType, IntegrityReport } from 'src/enum.js';
import { getForkSchemaPhase, readsForkSidecar } from 'src/repositories/fork-derived-results.js';
import { DB } from 'src/schema/index.js';
import { IntegrityReportTable } from 'src/schema/tables/integrity-report.table.js';

export type ReportPaginationOptions = {
  cursor?: string;
  limit: number;
};

@Injectable()
export class IntegrityRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

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
    const phase = await getForkSchemaPhase(this.db);
    return this.db
      .withSchema(readsForkSidecar(phase) ? 'immich_fork' : 'public')
      .selectFrom('asset_video_duplicate_frame')
      .select('path')
      .where('path', 'in', paths)
      .execute();
  }

  /**
   * Edited masters, previews and developed files brought back (FL-113, FL-64) live beside the
   * asset's thumbnails but are tracked by their develop version, not `asset_file`. Retained video
   * versions (FL-39) own their master, its lineage sidecar, proxy and thumbnails the same way, and an
   * edited master in `asset_file` owns its lineage sidecar. Without this
   * the untracked-file check would report — and offer to delete — a person's saved edits.
   */
  async getDevelopRevisionPathsByPaths(paths: string[]): Promise<{ path: string }[]> {
    if (paths.length === 0) {
      return [];
    }
    const { rows } = await sql<{ path: string }>`
      SELECT "masterPath" AS path FROM immich_fork.asset_develop_revision WHERE "masterPath" IN (${sql.join(paths)})
      UNION
      SELECT "previewPath" AS path FROM immich_fork.asset_develop_revision WHERE "previewPath" IN (${sql.join(paths)})
      UNION
      SELECT "masterPath" AS path FROM immich_fork.video_edit_version WHERE "masterPath" IN (${sql.join(paths)})
      UNION
      SELECT "proxyPath" AS path FROM immich_fork.video_edit_version WHERE "proxyPath" IN (${sql.join(paths)})
      UNION
      SELECT file->>'path' AS path FROM immich_fork.video_edit_version version, jsonb_array_elements(version.files) file
      WHERE file->>'path' IN (${sql.join(paths)})
      UNION
      SELECT "masterPath" || '.lineage.json' AS path FROM immich_fork.video_edit_version
      WHERE "masterPath" || '.lineage.json' IN (${sql.join(paths)})
      UNION
      SELECT path || '.lineage.json' AS path FROM public.asset_file
      WHERE "isEdited" AND type = 'encoded_video' AND path || '.lineage.json' IN (${sql.join(paths)})
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
      { path: string; reportId: string | null } & (
        { assetId: string; fileAssetId: null } | { assetId: null; fileAssetId: string }
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
