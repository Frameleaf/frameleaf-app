import { Injectable } from '@nestjs/common';
import { type Insertable, type Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { InteractiveAdmissionSource } from 'src/repositories/studio-source-admission.js';
import { EXTERNAL_SCAN_CHECKSUM } from 'src/constants.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetFileType, AssetStatus, ChecksumAlgorithm, IntegrityReport } from 'src/enum.js';
import { AssetLocalEffectRepository } from 'src/repositories/asset-local-effect.repository.js';
import { countPathReferences } from 'src/repositories/physical-file.repository.js';
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
  /** Source-owner revocation facts, independent of the requesting viewer's account. */
  sourceEpochs(ids: string[]) {
    return AssetLocalEffectRepository.sourceEpochs(this.db, ids);
  }

  /** Owner and original stream view observed together before the first async access decision. */
  async interactiveAdmissionViews(ids: string[]): Promise<InteractiveAdmissionSource[]> {
    if (ids.length === 0) return [];
    const { rows } = await sql<InteractiveAdmissionSource>`SELECT a.id AS "assetId",a."ownerId",s."streamEpoch",
      coalesce(s."nextSequence"-1,0)::text AS sequence FROM asset a
      LEFT JOIN asset_local_effect_stream s ON s."ownerId"=a."ownerId"
      WHERE a.id=ANY(${[...new Set(ids)].sort()}::uuid[]) ORDER BY a.id`.execute(this.db);
    return rows;
  }

  /** Current own library only, using the owner-access lock and hidden-content predicates. */
  getSafetyQuery(auth: AuthDto, hashes?: string[]) {
    return this.getLifecycleSafetyQuery(auth, AssetStatus.Active, hashes);
  }

  /** Internal reversible lifecycle proof; the ordinary SafetyQuery remains active-only. */
  getLifecycleSafetyQuery(auth: AuthDto, status: AssetStatus.Active | AssetStatus.Trashed, hashes?: string[]) {
    const privacy = auth.hiddenContent ?? auth.hideNsfwAssets;
    return this.getOwnedOriginalSafetyQuery(auth.user.id, hashes, status)
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
  getOwnedOriginalSafetyQuery(
    ownerId: string,
    hashes?: string[],
    status: AssetStatus.Active | AssetStatus.Trashed = AssetStatus.Active,
  ) {
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
      .where('asset.deletedAt', status === AssetStatus.Active ? 'is' : 'is not', null)
      .where('asset.status', '=', status)
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
    const byType = new Map(counts.map(({ type, count }) => [type, count]));
    return Object.fromEntries(Object.values(IntegrityReport).map((type) => [type, byType.get(type) || 0])) as Record<
      IntegrityReport,
      number
    >;
  }
  /**
   * FL-520: one count per kind of problem across the two checkers that report them: the file checks
   * (`integrity_report`) and Library care's missing/damaged scanner (`asset_health`). A photo both
   * report is counted once. `rawToMatch` is how many of the missing photos are RAW originals, which a
   * search for missing files matches against copies on the drive.
   */
  async getFindingsOverview(rawExtensions: readonly string[]) {
    const raw = rawExtensions.length > 0 ? rawExtensions.map((extension) => `%${extension.toLowerCase()}`) : ['%.\0'];
    const { rows } = await sql<{ missing: number; damaged: number; stray: number; rawToMatch: number }>`
      WITH missing AS (
        SELECT coalesce(r."assetId"::text, 'file:' || r."fileAssetId"::text, 'path:' || r.path) AS key, r."assetId"
        FROM public.integrity_report r
        WHERE r.type = ${IntegrityReport.MissingFile}
        UNION
        SELECT h."assetId"::text AS key, h."assetId"
        FROM public.asset_health h JOIN public.asset a ON a.id = h."assetId"
        WHERE h.category = 'missing' AND h.status IN ('missing', 'candidate', 'found') AND a."deletedAt" IS NULL
      ),
      damaged AS (
        SELECT coalesce(r."assetId"::text, 'path:' || r.path) AS key
        FROM public.integrity_report r
        WHERE r.type = ${IntegrityReport.ChecksumFail}
        UNION
        SELECT h."assetId"::text AS key
        FROM public.asset_health h JOIN public.asset a ON a.id = h."assetId"
        WHERE h.category = 'corrupt' AND h.status IN ('corrupt_confirmed', 'corrupt_suspect', 'trash_queued')
          AND a."deletedAt" IS NULL
      )
      SELECT
        (SELECT count(*)::int FROM missing) AS missing,
        (SELECT count(*)::int FROM damaged) AS damaged,
        (SELECT count(*)::int FROM public.integrity_report WHERE type = ${IntegrityReport.UntrackedFile}) AS stray,
        (SELECT count(DISTINCT m."assetId")::int FROM missing m JOIN public.asset a ON a.id = m."assetId"
          WHERE lower(a."originalFileName") LIKE ANY (${raw}::text[])) AS "rawToMatch"`.execute(this.db);
    return rows[0];
  }

  /** FL-520: missing-file findings under each folder (a folder path ending in `/`). */
  async countMissingUnder(folders: readonly string[]): Promise<number[]> {
    if (folders.length === 0) {
      return [];
    }
    const { rows } = await sql<{ folder: string; count: number }>`
      SELECT f.folder, count(r.id)::int AS count
      FROM unnest(${[...folders]}::text[]) AS f(folder)
      LEFT JOIN public.integrity_report r
        ON r.type = ${IntegrityReport.MissingFile} AND starts_with(r.path, f.folder)
      GROUP BY f.folder`.execute(this.db);
    const byFolder = new Map(rows.map((row) => [row.folder, row.count]));
    return folders.map((folder) => byFolder.get(folder) ?? 0);
  }

  /**
   * FL-520: the photos behind the missing or damaged findings of both checkers, for "Restore from a
   * backup". Only photos still in the library; at most `limit`.
   */
  async getFindingAssetIds(kind: 'missing' | 'damaged', limit: number): Promise<string[]> {
    const type = kind === 'missing' ? IntegrityReport.MissingFile : IntegrityReport.ChecksumFail;
    const statuses =
      kind === 'missing' ? ['missing', 'candidate', 'found'] : ['corrupt_confirmed', 'corrupt_suspect', 'trash_queued'];
    const { rows } = await sql<{ assetId: string }>`
      SELECT DISTINCT ids."assetId" FROM (
        SELECT r."assetId" FROM public.integrity_report r WHERE r.type = ${type} AND r."assetId" IS NOT NULL
        UNION
        SELECT h."assetId" FROM public.asset_health h WHERE h.category = ${kind === 'missing' ? 'missing' : 'corrupt'}
          AND h.status = ANY (${statuses}::text[])
      ) ids JOIN public.asset a ON a.id = ids."assetId"
      WHERE a."deletedAt" IS NULL
      ORDER BY ids."assetId"
      LIMIT ${limit}`.execute(this.db);
    return rows.map((row) => row.assetId);
  }

  @GenerateSql({ params: [{ cursor: DummyValue.NUMBER, limit: 100 }, DummyValue.STRING] })
  async getIntegrityReport(pagination: ReportPaginationOptions, type: IntegrityReport) {
    const items = await this.db
      .selectFrom('integrity_report')
      // FL-737: a finding is named by its photo's own file name, as Missing files and Damaged files name it
      .leftJoin('asset', 'asset.id', 'integrity_report.assetId')
      .select([
        'integrity_report.id',
        'integrity_report.type',
        'integrity_report.path',
        'integrity_report.assetId',
        'integrity_report.fileAssetId',
        'integrity_report.createdAt',
        'asset.originalFileName',
      ])
      .where('integrity_report.type', '=', type)
      .$if(pagination.cursor !== undefined, (eb) => eb.where('integrity_report.id', '<=', pagination.cursor!))
      .orderBy('integrity_report.id', 'desc')
      .limit(pagination.limit + 1)
      .execute();
    return {
      items: items.slice(0, pagination.limit),
      nextCursor: items.at(pagination.limit)?.id,
    };
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
      SELECT "masterPath" AS path FROM public.asset_develop_revision WHERE "masterPath" = ANY(${paths}::text[])
      UNION
      SELECT "previewPath" AS path FROM public.asset_develop_revision WHERE "previewPath" = ANY(${paths}::text[])
      UNION SELECT "hdrMasterPath" AS path FROM public.asset_develop_revision WHERE "hdrMasterPath" = ANY(${paths}::text[])
      UNION SELECT "hdrPreviewPath" AS path FROM public.asset_develop_revision WHERE "hdrPreviewPath" = ANY(${paths}::text[])
      UNION
      SELECT "masterPath" AS path FROM public.video_edit_version WHERE "masterPath" = ANY(${paths}::text[])
      UNION
      SELECT "proxyPath" AS path FROM public.video_edit_version WHERE "proxyPath" = ANY(${paths}::text[])
      UNION
      SELECT file->>'path' AS path FROM public.video_edit_version version, jsonb_array_elements(version.files) file
      WHERE file->>'path' = ANY(${paths}::text[])
      UNION
      SELECT "masterPath" || '.lineage.json' AS path FROM public.video_edit_version
      WHERE "masterPath" || '.lineage.json' = ANY(${paths}::text[])
      UNION
      SELECT path || '.lineage.json' AS path FROM public.asset_file
      WHERE "isEdited" AND type = 'encoded_video' AND path || '.lineage.json' = ANY(${paths}::text[])
      UNION
      SELECT path FROM public.studio_hdr_intermediate WHERE path = ANY(${paths}::text[])
      UNION
      SELECT path FROM public.asset_develop_artifact WHERE path = ANY(${paths}::text[])
      UNION
      SELECT photo->>'previewPath' AS path FROM public.photography_workflow workflow,
        jsonb_array_elements(COALESCE(workflow.value->'published'->'photos','[]'::jsonb) || COALESCE(workflow.value->'publication'->'photos','[]'::jsonb)) photo
      WHERE photo->>'previewPath' = ANY(${paths}::text[])
      UNION
      SELECT photo->>'thumbnailPath' AS path FROM public.photography_workflow workflow,
        jsonb_array_elements(COALESCE(workflow.value->'published'->'photos','[]'::jsonb) || COALESCE(workflow.value->'publication'->'photos','[]'::jsonb)) photo
      WHERE photo->>'thumbnailPath' = ANY(${paths}::text[])
      UNION
      SELECT item->>'finalPath' AS path FROM public.photography_workflow workflow,
        jsonb_array_elements(workflow.value->'orders') orders,jsonb_array_elements(orders->'items') item
      WHERE item->>'finalPath' = ANY(${paths}::text[])
      UNION
      SELECT output->>'approvalPreviewPath' AS path FROM public.photography_workflow workflow,
      jsonb_array_elements(workflow.value->'orders') orders,jsonb_array_elements(orders->'items') item,
      jsonb_array_elements(COALESCE(item->'outputs','[]'::jsonb)) output
      WHERE output->>'approvalPreviewPath' = ANY(${paths}::text[])
      UNION
      SELECT output->>'finalPath' AS path FROM public.photography_workflow workflow,
      jsonb_array_elements(workflow.value->'orders') orders,jsonb_array_elements(orders->'items') item,
      jsonb_array_elements(COALESCE(item->'outputs','[]'::jsonb)) output
      WHERE output->>'finalPath' = ANY(${paths}::text[])
      UNION
      SELECT workflow.value->'published'->>'logoPath' AS path FROM public.photography_workflow workflow
      WHERE workflow.value->'published'->>'logoPath' = ANY(${paths}::text[])
      UNION
      SELECT workflow.value->'publication'->>'logoPath' AS path FROM public.photography_workflow workflow
      WHERE workflow.value->'publication'->>'logoPath' = ANY(${paths}::text[])
    `.execute(this.db);
    return rows;
  }
  /**
   * The paths some row keeps on disk. The bulk queries are a fast pre-filter for the common owners;
   * whatever they leave is checked with `countPathReferences`, the count every file delete already
   * trusts, so a table that owns generated files is registered there once and never forgotten here.
   */
  @GenerateSql({ params: [DummyValue.STRING] })
  async getTrackedPaths(paths: string[]): Promise<{ path: string }[]> {
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
      .union((eb) =>
        eb
          .selectFrom('video_moment_frame')
          .select('video_moment_frame.path as path')
          .where('video_moment_frame.path', 'in', paths),
      )
      .execute();
    const found = new Set(
      [
        ...tracked,
        ...(await this.getDevelopRevisionPathsByPaths(paths)),
        ...(await this.getRegisteredFilePathsByPaths(paths)),
        ...(await this.getInFlightPathsByPaths(paths)),
      ].map(({ path }) => path),
    );
    // ponytail: a few queries per leftover path, fine while stray files stay rare
    const rest = paths.filter((path) => !found.has(path));
    if (rest.length > 0) {
      await this.db.transaction().execute(async (trx) => {
        for (const path of rest) {
          if ((await countPathReferences(trx, path)) > 0) {
            found.add(path);
          }
        }
      });
    }
    return [...found].map((path) => ({ path }));
  }
  /**
   * Files a job is still working on: a Takeout copy before its photo exists, a copy Library care found
   * for a missing original and may relink, and both ends (and the staged copy) of an interrupted move.
   * Their owners release them on their own terms, so they are not in `countPathReferences`, but the
   * stray-file check must never offer to delete them.
   */
  async getInFlightPathsByPaths(paths: string[]): Promise<{ path: string }[]> {
    if (paths.length === 0) {
      return [];
    }
    const { rows } = await sql<{ path: string }>`
      SELECT "createPath" AS path FROM public.takeout_item WHERE "createPath" = ANY(${paths}::text[])
      UNION SELECT "candidatePath" FROM public.asset_health_candidate WHERE "candidatePath" = ANY(${paths}::text[])
      UNION SELECT "oldPath" FROM public.move_history WHERE "oldPath" = ANY(${paths}::text[])
      UNION SELECT "newPath" FROM public.move_history WHERE "newPath" = ANY(${paths}::text[])
      UNION SELECT staged FROM public.move_history, LATERAL (SELECT "newPath" || '.' || id::text || '.moving' AS staged) s
      WHERE staged = ANY(${paths}::text[])
    `.execute(this.db);
    return rows;
  }
  /**
   * FL-412: paths registered as stored files (`physical_file`). A registered file is tracked even while no
   * asset names it, so the untracked-file check never reports, and never offers to delete, a stored original.
   */
  async getRegisteredFilePathsByPaths(paths: string[]): Promise<{ path: string }[]> {
    if (paths.length === 0) {
      return [];
    }
    return this.db
      .selectFrom('physical_file')
      .select('physical_file.path')
      .where('physical_file.path', 'in', paths)
      .execute();
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
  /** Empties one check's list of findings. Only the rows go: no file or photo is touched. */
  @GenerateSql({ params: [IntegrityReport.MissingFile] })
  async deleteByType(type: IntegrityReport) {
    const result = await this.db.deleteFrom('integrity_report').where('type', '=', type).executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}
