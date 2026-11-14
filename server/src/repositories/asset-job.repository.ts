import { Injectable, NotFoundException } from '@nestjs/common';
import { Kysely, type Transaction, sql } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ProcessingFailureActionDto, ProcessingFailureQueryDto } from 'src/dtos/processing-failure.dto.js';
import { columns } from 'src/database.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import {
  AssetFileType,
  AssetMetadataKey,
  AssetStatus,
  AssetType,
  AssetVisibility,
  JobName,
  LibraryScope,
  MediaHealthCategory,
  QueueName,
} from 'src/enum.js';
import { RAW_RUNG_STEP, processingFailureSteps } from 'src/queue/processing-failure.js';
import { publicationDatabase } from 'src/queue/transaction.js';
import { DB } from 'src/schema/index.js';
import {
  anyUuid,
  asUuid,
  withAudioStream,
  withDefaultVisibility,
  withEdits,
  withExif,
  withExifInner,
  withFaces,
  withFacesAndPeople,
  withFilePath,
  withFiles,
  withHiddenContentFilter,
  withVideoFormat,
  withVideoStream,
} from 'src/utils/database.js';
import { getHiddenContentQueryOptions, getOthersRulesQueryOptions } from 'src/utils/hidden-content.js';
import { libraryScopePredicate } from 'src/utils/library-scope.js';
import { effectiveVisibility, getLockedOwnerId, isLocked, isNotLocked, notLockedOrOwnedBy } from 'src/utils/locked.js';
import { mimeTypes } from 'src/utils/mime-types.js';

/**
 * FL-1287: a partner copy with a live source never renders its own thumbnails; it shares the source's, handed
 * over by the source's job. Its own edits still render.
 */
const rendersOwnThumbnails = sql<boolean>`(asset."isEdited" OR NOT EXISTS (
  SELECT 1 FROM public.asset_origin origin
  JOIN asset source ON source.id = origin."sourceAssetId"
  WHERE origin."assetId" = asset.id AND source."deletedAt" IS NULL AND source.status = ${sql.lit(AssetStatus.Active)}
))`;
/** FL-1487: a partner copy with a live source never converts its own video; it plays the source's. */
const convertsOwnVideo = sql<boolean>`NOT EXISTS (
  SELECT 1 FROM public.asset_origin origin
  JOIN asset source ON source.id = origin."sourceAssetId"
  WHERE origin."assetId" = asset.id AND source."deletedAt" IS NULL AND source.status = ${sql.lit(AssetStatus.Active)}
)`;
/**
 * FL-1287: a partner copy that rendered its own thumbnail or preview before copies shared them, while its live
 * source has one at another path. Its job (the nightly "Missing" scan) links the source's and deletes its own.
 */
const keepsOwnCopyThumbnails = sql<boolean>`EXISTS (
  SELECT 1 FROM public.asset_origin origin
  JOIN asset source ON source.id = origin."sourceAssetId"
  JOIN asset_file source_file ON source_file."assetId" = source.id AND source_file."isEdited" = false
    AND source_file.type IN (${sql.lit(AssetFileType.Thumbnail)}, ${sql.lit(AssetFileType.Preview)})
  JOIN asset_file copy_file ON copy_file."assetId" = asset.id AND copy_file."isEdited" = false
    AND copy_file.type = source_file.type
  WHERE origin."assetId" = asset.id AND source."deletedAt" IS NULL AND source.status = ${sql.lit(AssetStatus.Active)}
    AND copy_file.path <> source_file.path
)`;

/**
 * FL-1337: a photo Library care has in hand, with a file problem still open or a fix still to run (the hand-off
 * of a preview that would not open, or a fix waiting for its drive). Its previews are Library care's to remake
 * after a fix, so the overnight check (FL-811) never queues them again.
 */
const notInLibraryCare = sql<boolean>`not exists (
    select 1 from public.asset_health health
    where health."assetId" = asset.id and health."resolvedAt" is null and health."dismissedAt" is null
  ) and not exists (
    select 1 from job
    where job.queue = ${QueueName.MediaHealth} and job.name = ${JobName.MediaHealthFixAsset}
      and job.state in ('pending', 'waiting', 'active') and lower(job.data->>'id') collate "C" = asset.id::text
    offset 0
  )`;

/**
 * FL-1347: a photo whose original Library care has open as missing. There is no file to read its metadata from or
 * encode, so the overnight check (FL-811) leaves both steps to Library care, which reads the photo again once the
 * original is back. A damaged original is still there, so it is not left out here.
 */
const originalNotMissing = sql<boolean>`not exists (
    select 1 from public.asset_health health
    where health."assetId" = asset.id and health.category = ${sql.lit(MediaHealthCategory.Missing)}
      and health."resolvedAt" is null and health."dismissedAt" is null
  )`;

/**
 * FL-1355: a RAW original whose sensor did not render already has its answer (the camera's preview, or no
 * picture yet). The overnight check leaves it alone, or it would run the whole ladder again every night for a
 * full-size rendition that cannot be made; a decoder update or the person's own retry tries it again.
 */
const rawSensorNotGivenUp = sql<boolean>`not exists (
    select 1 from public.asset_processing_failure rung
    where rung."assetId" = asset.id and rung.step = ${sql.lit(RAW_RUNG_STEP)}
  )`;

type ProcessingFailureStep = ProcessingFailureActionDto['items'][number]['step'];

type ReconciledJob =
  | JobName.AssetExtractMetadata
  | JobName.AssetGenerateThumbnails
  | JobName.AssetEncodeVideo
  | JobName.SmartSearch
  | JobName.AssetDetectFaces
  | JobName.Ocr;

@Injectable()
export class AssetJobRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {
    this.db = publicationDatabase(this.db);
  }

  /** Select only inputs each normal processor can use, with no other live job for the same step. */
  selectionForUnfinished(
    name: ReconciledJob,
    options: { queue: QueueName; fullsizeEnabled: boolean; videoPolicy: string; after?: string | null },
  ) {
    const selection = {
      [JobName.AssetExtractMetadata]: () =>
        this.selectionForMetadataExtraction(false, false, true).where(originalNotMissing),
      [JobName.AssetGenerateThumbnails]: () =>
        this.selectionForThumbnailJob({ force: false, fullsizeEnabled: options.fullsizeEnabled })
          .where(notInLibraryCare)
          .where(rawSensorNotGivenUp),
      [JobName.AssetEncodeVideo]: () =>
        this.selectionForVideoConversion(false)
          .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
          .innerJoin('asset_job_status', 'asset_job_status.assetId', 'asset.id')
          .where('asset_job_status.metadataExtractedAt', 'is not', null)
          .where(
            sql<boolean>`"asset_job_status"."transcodeSkippedFor" is distinct from
            (encode(asset.checksum, 'hex') || ':' || ${options.videoPolicy})`,
          )
          // a copy whose source is trashed or deleted later is picked up again and converts its own
          .where(convertsOwnVideo)
          .where(originalNotMissing),
      [JobName.SmartSearch]: () => this.selectionForEncodeClip(false),
      [JobName.AssetDetectFaces]: () => this.selectionForDetectFacesJob(false).clearOrderBy(),
      [JobName.Ocr]: () => this.assetsWithPreviews().select('asset.id').where('job_status.ocrAt', 'is', null),
    }[name]();

    // Earlier pages only enqueue IDs below this cursor. Keep those rows out of the live-job lookup.
    const subject = sql`lower(job.data->>'id') collate "C"`;
    const liveRange = options.after ? sql`and ${subject} > ${options.after}` : sql``;
    // Keep this indexed lookup correlated even before PostgreSQL has analyzed a newly filled job table.
    return selection.where(sql<boolean>`asset.status = 'active' and not asset."isOffline" and not exists (
        select 1 from job
        where job.queue = ${options.queue} and job.name = ${name} and job.state in ('pending', 'waiting', 'active')
          and ${subject} = asset.id::text ${liveRange}
        offset 0
      )`);
  }

  /**
   * FL-1355: which rung of the RAW ladder a file's preview came from, when it was not the sensor:
   * `embedded/<why>` (showing the camera's preview) or `placeholder/<why>` (no picture yet). It is kept as a
   * row of its own step, so no job is set aside by it, the "Couldn't process" inbox never lists it, and it
   * goes when the photo gets another file. `null` clears it: the sensor rendered.
   */
  async setRawRung(assetId: string, rung: string | null): Promise<void> {
    await (rung
      ? this.db
          .insertInto('asset_processing_failure')
          .values({ assetId, step: RAW_RUNG_STEP, attempts: 1, lastError: rung, lastFailedAt: new Date() })
          .onConflict((oc) =>
            oc.columns(['assetId', 'step']).doUpdateSet({ lastError: rung, lastFailedAt: new Date() }),
          )
          .execute()
      : this.db
          .deleteFrom('asset_processing_failure')
          .where('assetId', '=', assetId)
          .where('step', '=', RAW_RUNG_STEP)
          .execute());
  }

  /** FL-1355: every RAW original whose sensor has not rendered, to try again with a newer decoder. */
  async getRawRungAssetIds(): Promise<string[]> {
    const rows = await this.db
      .selectFrom('asset_processing_failure')
      .select('assetId')
      .where('step', '=', RAW_RUNG_STEP)
      .execute();
    return rows.map(({ assetId }) => assetId);
  }

  private visibleProcessingFailures(auth: AuthDto, db: Kysely<DB>, userId?: string) {
    const ownerId = auth.user.isAdmin ? userId : auth.user.id;
    return db
      .selectFrom('asset_processing_failure as failure')
      .innerJoin('asset', 'asset.id', 'failure.assetId')
      .where('asset.deletedAt', 'is', null)
      .where(notLockedOrOwnedBy(getLockedOwnerId(auth)))
      .$call((qb) =>
        withHiddenContentFilter(qb, {
          ...getHiddenContentQueryOptions(auth),
          ...getOthersRulesQueryOptions(auth),
        }),
      )
      .$if(!!ownerId, (qb) => qb.where('asset.ownerId', '=', ownerId!));
  }

  /** FL-862: how many files the reader may see that are waiting on a decision, and how many of them are set aside. */
  async countProcessingFailures(auth: AuthDto) {
    const row = await this.visibleProcessingFailures(auth, this.db)
      .where('failure.dismissedAt', 'is', null)
      .where('failure.step', 'in', processingFailureSteps)
      .select([
        sql<number>`count(distinct failure."assetId")::int`.as('count'),
        sql<number>`count(distinct failure."assetId") filter (where failure."quarantinedAt" is not null)::int`.as(
          'setAside',
        ),
      ])
      .executeTakeFirst();
    return { count: row?.count ?? 0, setAside: row?.setAside ?? 0 };
  }

  /**
   * FL-1409: the Library asks for one step with `includeDismissed`, to tell a photo whose thumbnail can't be made
   * (failed, kept as it is or stopped) from one still waiting for it.
   */
  getProcessingFailures(auth: AuthDto, { userId, step, includeDismissed, take, skip }: ProcessingFailureQueryDto) {
    return this.visibleProcessingFailures(auth, this.db, userId)
      .innerJoin('user as owner', 'owner.id', 'asset.ownerId')
      .$if(!includeDismissed, (qb) => qb.where('failure.dismissedAt', 'is', null))
      .where('failure.step', 'in', step ? [step] : processingFailureSteps)
      .select([
        'failure.assetId',
        'failure.step',
        'failure.attempts',
        'failure.lastError as cause',
        'failure.lastFailedAt',
        'failure.quarantinedAt',
        'asset.ownerId',
        'owner.name as ownerName',
        'asset.originalFileName as fileName',
      ])
      .orderBy('failure.lastFailedAt', 'desc')
      .orderBy('failure.assetId')
      .orderBy('failure.step')
      .limit(take)
      .offset(skip)
      .execute();
  }

  async updateProcessingFailures(
    auth: AuthDto,
    { items }: ProcessingFailureActionDto,
    retry?: {
      queueName: (step: ProcessingFailureStep) => QueueName;
      enqueue: (tx: Transaction<DB>, step: ProcessingFailureStep, id: string) => Promise<void>;
    },
  ) {
    await this.db.transaction().execute(async (tx) => {
      if (retry) {
        const queues = [...new Set(items.map(({ step }) => retry.queueName(step)))];
        // Claim holds the queue row until a pending job becomes active or blocked.
        await tx
          .selectFrom('job_queue')
          .select('name')
          .where('name', 'in', queues)
          .orderBy('name')
          .forNoKeyUpdate()
          .execute();
      }
      // Stable locking order makes two overlapping bulk actions safe.
      const ordered = items.toSorted((a, b) => a.assetId.localeCompare(b.assetId) || a.step.localeCompare(b.step));
      for (const { assetId, step } of ordered) {
        const row = await this.visibleProcessingFailures(auth, tx)
          .where('failure.assetId', '=', assetId)
          .where('failure.step', '=', step)
          .select(['failure.attempts', 'failure.dismissedAt', 'failure.quarantinedAt'])
          .forUpdate('failure')
          .executeTakeFirst();
        if (!row) throw new NotFoundException('Processing failure not found');
        const update = tx
          .updateTable('asset_processing_failure')
          .where('assetId', '=', assetId)
          .where('step', '=', step);
        if (!retry) {
          await update.set({ dismissedAt: new Date() }).execute();
          continue;
        }
        if (row.attempts === 0 && !row.dismissedAt && !row.quarantinedAt) continue;
        await update.set({ attempts: 0, dismissedAt: null, quarantinedAt: null }).execute();
        const live = await tx
          .selectFrom('job')
          .select('id')
          .where('queue', '=', retry.queueName(step))
          .where('name', '=', step)
          .where('state', 'in', ['pending', 'waiting', 'active'])
          .where(sql<boolean>`lower(data->>'id') collate "C" = ${assetId.toLowerCase()}`)
          .limit(1)
          .executeTakeFirst();
        if (!live) await retry.enqueue(tx, step, assetId.toLowerCase());
      }
    });
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForSearchDuplicatesJob(id: string) {
    return (
      this.db
        .selectFrom('asset')
        .where('asset.id', '=', asUuid(id))
        .leftJoin('smart_search', 'asset.id', 'smart_search.assetId')
        // `locked` for a locked asset (FL-34): duplicate review never groups locked media
        .select([
          'id',
          'type',
          'ownerId',
          'duplicateId',
          'stackId',
          'deletedAt',
          effectiveVisibility('asset').as('visibility'),
          'smart_search.embedding',
        ])
        .limit(1)
        .executeTakeFirst()
    );
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForSidecarWriteJob(id: string, kysely: Kysely<DB> = this.db) {
    return kysely
      .selectFrom('asset')
      .where('asset.id', '=', asUuid(id))
      .select(['id', 'ownerId', 'originalPath', 'physicalOriginalFileId', 'localDateTime'])
      .select((eb) =>
        eb
          .selectFrom('library')
          .select('readOnly')
          .whereRef('library.id', '=', 'asset.libraryId')
          .as('libraryReadOnly'),
      )
      .select((eb) => withFiles(eb, AssetFileType.Sidecar))
      .$call(withExifInner)
      .limit(1)
      .executeTakeFirst();
  }

  getForSidecarFaces(id: string, kysely: Kysely<DB>) {
    return kysely
      .selectFrom('asset')
      .select(withFacesAndPeople({}))
      .where('asset.id', '=', asUuid(id))
      .where('asset.type', '=', AssetType.Image)
      .where('asset.libraryScope', '=', LibraryScope.Personal)
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', 'in', [AssetVisibility.Timeline, AssetVisibility.Archive])
      .where(isNotLocked('asset'))
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForSidecarCheckJob(id: string, kysely: Kysely<DB> = this.db) {
    return kysely
      .selectFrom('asset')
      .where('asset.id', '=', asUuid(id))
      .select(['id', 'ownerId', 'originalPath', 'physicalOriginalFileId'])
      .select((eb) => withFiles(eb, AssetFileType.Sidecar))
      .limit(1)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [{ force: false, fullsizeEnabled: true }], stream: true })
  streamForThumbnailJob(options: { force: boolean | undefined; fullsizeEnabled: boolean }) {
    return this.selectionForThumbnailJob(options).stream();
  }

  selectionForThumbnailJob(options: { force: boolean | undefined; fullsizeEnabled: boolean; hdrBackfill?: boolean }) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id', 'asset.isEdited'])
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', '!=', sql.lit(AssetVisibility.Hidden))
      .$if(!!options.force, (qb) => qb.where(rendersOwnThumbnails))
      .$if(!options.force, (qb) =>
        qb
          // A status row can exist before metadata extraction, for example on a partner copy.
          .innerJoin('asset_job_status', 'asset_job_status.assetId', 'asset.id')
          .where(({ exists, selectFrom }) =>
            exists(selectFrom('asset_exif').select('assetId').whereRef('asset_exif.assetId', '=', 'asset.id')),
          )
          .where(({ and, eb, exists, not, or, selectFrom }) => {
            const file = (type: AssetFileType) =>
              selectFrom('asset_file').whereRef('assetId', '=', 'asset.id').where('type', '=', sql.lit(type));

            const conditions = [
              not(exists(file(AssetFileType.Thumbnail))),
              not(exists(file(AssetFileType.Preview))),
              and([
                eb('asset.isEdited', '=', sql.lit(true)),
                not(exists(file(AssetFileType.FullSize).where('asset_file.isEdited', '=', sql.lit(true)))),
              ]),
              eb('asset.thumbhash', 'is', null),
              keepsOwnCopyThumbnails,
            ];

            if (options.hdrBackfill) {
              conditions.push(
                and([
                  eb('asset.type', '=', sql.lit(AssetType.Image)),
                  eb('asset.isEdited', '=', false),
                  exists(
                    selectFrom('asset_exif')
                      .whereRef('assetId', '=', 'asset.id')
                      .where(sql<string>`"imageEncoding"->>'dynamicRange'`, '=', 'hdr')
                      .where(sql<string>`"imageEncoding"->>'reconstructionAvailable'`, '=', 'true'),
                  ),
                  or([
                    not(exists(file(AssetFileType.HdrPreview).where('asset_file.isEdited', '=', false))),
                    not(exists(file(AssetFileType.HdrFullSize).where('asset_file.isEdited', '=', false))),
                  ]),
                ]),
              );
            }

            if (options.fullsizeEnabled) {
              const isWebUnsupported = sql.join(
                Object.keys(mimeTypes.webUnsupportedImage).map((ext) => sql.lit(`%${ext}`)),
              );
              conditions.push(
                and([
                  not(exists(file(AssetFileType.FullSize))),
                  eb(sql`f_unaccent(asset."originalFileName")`, 'ilike', sql`any(array[${isWebUnsupported}]::text[])`),
                ]),
              );
            }

            return or(conditions);
          }),
      );
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForMigrationJob(id: string) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id', 'asset.ownerId'])
      .select(withFiles)
      .where('asset.id', '=', id)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForGenerateThumbnailJob(id: string) {
    return (
      this.db
        .selectFrom('asset')
        .select([
          'asset.id',
          'asset.visibility',
          'asset.originalFileName',
          'asset.originalPath',
          'asset.ownerId',
          'asset.thumbhash',
          'asset.type',
          // `checksum` identifies the exact original a still edited master was rendered from (FL-39 lineage).
          'asset.checksum',
          'asset.checksumAlgorithm',
        ])
        .select((eb) =>
          jsonArrayFrom(
            eb
              .selectFrom('asset_file')
              .select(columns.assetFilesForThumbnail)
              .whereRef('asset_file.assetId', '=', 'asset.id')
              .where('asset_file.type', 'in', [
                AssetFileType.Thumbnail,
                AssetFileType.Preview,
                AssetFileType.FullSize,
                AssetFileType.HdrPreview,
                AssetFileType.HdrFullSize,
              ]),
          ).as('files'),
        )
        .select(withEdits)
        .$call(withExifInner)
        .leftJoin('asset_video', 'asset_video.assetId', 'asset.id')
        .select((eb) => withVideoStream(eb).as('videoStream'))
        .select((eb) => withVideoFormat(eb).as('format'))
        // FL-59: the owner's chosen video cover (a time in the video) is where the thumbnail is cut.
        .select((eb) =>
          eb
            .selectFrom('video_moment_index')
            .select('video_moment_index.coverTimestampMs')
            .whereRef('video_moment_index.assetId', '=', 'asset.id')
            .as('coverTimestampMs'),
        )
        .where('asset.id', '=', id)
        .executeTakeFirst()
    );
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForMetadataExtraction(id: string) {
    return this.db
      .selectFrom('asset')
      .select(columns.asset)
      .select(isLocked('asset').as('isLocked'))
      .select(withFacesAndPeople({}))
      .select((eb) => withFiles(eb, AssetFileType.Sidecar))
      .innerJoin('user', 'user.id', 'asset.ownerId')
      .select(['user.clusterGroupId'])
      .where('asset.id', '=', id)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getLockedPropertiesForMetadataExtraction(assetId: string, kysely: Kysely<DB> = this.db) {
    return kysely
      .selectFrom('asset_exif')
      .select('asset_exif.lockedProperties')
      .where('asset_exif.assetId', '=', assetId)
      .executeTakeFirst()
      .then((row) => row?.lockedProperties ?? []);
  }

  @GenerateSql({ params: [DummyValue.UUID, AssetFileType.Thumbnail] })
  getAlbumThumbnailFiles(id: string, fileType?: AssetFileType) {
    return this.db
      .selectFrom('asset_file')
      .select(columns.assetFiles)
      .where('asset_file.assetId', '=', id)
      .$if(!!fileType, (qb) => qb.where('asset_file.type', '=', fileType!))
      .execute();
  }

  private assetsWithPreviews() {
    return (
      this.db
        .selectFrom('asset')
        // FL-1359: a font's preview is its specimen; search, faces, text reading and captions are for pictures
        .where('asset.type', '!=', sql.lit(AssetType.Other))
        .where('asset.visibility', '!=', AssetVisibility.Hidden)
        .where('asset.deletedAt', 'is', null)
        .innerJoin('asset_job_status as job_status', 'assetId', 'asset.id')
        .where((eb) =>
          eb.exists((qb) =>
            qb
              .selectFrom('asset_file')
              .whereRef('assetId', '=', 'asset.id')
              .where('asset_file.type', '=', AssetFileType.Preview),
          ),
        )
    );
  }

  @GenerateSql({ params: [], stream: true })
  streamForSearchDuplicates(force?: boolean) {
    return this.selectionForSearchDuplicates(force).stream();
  }

  selectionForSearchDuplicates(force?: boolean) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id'])
      .where('asset.deletedAt', 'is', null)
      .innerJoin('smart_search', 'asset.id', 'smart_search.assetId')
      .$call(withDefaultVisibility)
      .$if(!force, (qb) =>
        qb
          .innerJoin('asset_job_status as job_status', 'job_status.assetId', 'asset.id')
          .where('job_status.duplicatesDetectedAt', 'is', null),
      );
  }

  /** FL-651: videos to fingerprint; all of them when forced, else those without a fingerprint. */
  selectionForVideoFingerprint(force?: boolean) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id'])
      .where('asset.type', '=', sql.lit(AssetType.Video))
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', '!=', sql.lit(AssetVisibility.Hidden))
      .where(isNotLocked('asset'))
      .$if(!force, (qb) =>
        qb.where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('asset_video_fingerprint')
                .select('asset_video_fingerprint.assetId')
                .whereRef('asset_video_fingerprint.assetId', '=', 'asset.id'),
            ),
          ),
        ),
      );
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForVideoDuplicateFrameJob(id: string) {
    return this.db
      .selectFrom('asset')
      .innerJoin('asset_video', 'asset_video.assetId', 'asset.id')
      .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select(['asset.id', 'asset.ownerId', 'asset.originalPath', effectiveVisibility('asset').as('visibility')])
      .select((eb) => withVideoStream(eb).$notNull().as('videoStream'))
      .select((eb) => withVideoFormat(eb).$notNull().as('format'))
      .where('asset.id', '=', id)
      .where('asset.type', '=', sql.lit(AssetType.Video))
      .executeTakeFirst();
  }

  @GenerateSql({ params: [], stream: true })
  streamForEncodeClip(force?: boolean) {
    return this.selectionForEncodeClip(force).stream();
  }

  selectionForEncodeClip(force?: boolean) {
    return this.assetsWithPreviews()
      .select(['asset.id'])
      .$if(!force, (qb) =>
        qb.where((eb) => eb.not((eb) => eb.exists(eb.selectFrom('smart_search').whereRef('assetId', '=', 'asset.id')))),
      );
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForClipEncoding(id: string) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id', 'asset.visibility', 'asset.ownerId'])
      .select((eb) => withFiles(eb, AssetFileType.Preview))
      .where('asset.id', '=', id)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForDetectFacesJob(id: string) {
    return (
      this.db
        .selectFrom('asset')
        .where(libraryScopePredicate(LibraryScope.Personal))
        // FL-57: the checksum tells whether a face decision was made about this original
        .select(['asset.id', 'asset.visibility', 'asset.checksum'])
        .$call(withExifInner)
        .select((eb) => withFaces(eb, true, true))
        // FL-1387: a stored face box is a box on the unedited picture (the viewer applies the edits and
        // the person thumbnail crops the original), so faces are found in the unedited preview only.
        // The edits tell which of them a crop leaves out.
        .select((eb) => withFiles(eb, AssetFileType.Preview, false))
        .select(withEdits)
        .where('asset.id', '=', id)
        .executeTakeFirst()
    );
  }

  /** FL-1484: whose photo this is, so its AI work follows that person's choice about Frameleaf Cloud. */
  async getOwnerId(id: string): Promise<string | undefined> {
    const row = await this.db.selectFrom('asset').select('asset.ownerId').where('asset.id', '=', id).executeTakeFirst();
    return row?.ownerId;
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForOcr(id: string) {
    return this.db
      .selectFrom('asset')
      .select((eb) => ['asset.visibility', withFilePath(eb, AssetFileType.Preview).as('previewFile')])
      .where('asset.id', '=', id)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForImageEnrichment(id: string) {
    return this.db
      .selectFrom('asset')
      .leftJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
      .select((eb) => [
        'asset.id',
        'asset.ownerId',
        'asset.type',
        'asset.status',
        'asset.deletedAt',
        'asset.visibility',
        'asset_exif.description',
        withFilePath(eb, AssetFileType.Preview).as('previewFile'),
      ])
      .where('asset.id', '=', id)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [{ force: false, scoreVersion: 1 }], stream: true })
  streamForBestPhotosScoring(options: { force?: boolean; scoreVersion: number }) {
    return this.selectionForBestPhotosScoring(options).stream();
  }

  selectionForBestPhotosScoring(options: { force?: boolean; scoreVersion: number }) {
    return (
      this.db
        .selectFrom('asset')
        .where(libraryScopePredicate(LibraryScope.Personal))
        .select(['asset.id'])
        .where('asset.type', 'in', [sql.lit(AssetType.Image), sql.lit(AssetType.Video)])
        .where('asset.status', '=', sql.lit(AssetStatus.Active))
        .where('asset.deletedAt', 'is', null)
        // background work includes locked media (owner decision, September 22, 2026): stored visibility only
        .where('asset.visibility', 'in', [sql.lit(AssetVisibility.Archive), sql.lit(AssetVisibility.Timeline)])
        .where((eb) =>
          eb.exists((qb) =>
            qb
              .selectFrom('asset_file')
              .whereRef('asset_file.assetId', '=', 'asset.id')
              .where('asset_file.type', '=', sql.lit(AssetFileType.Preview)),
          ),
        )
        .$if(!options.force, (qb) =>
          qb.where((eb) =>
            eb.or([
              eb.not(
                eb.exists(
                  eb.selectFrom('asset_best_photo_score').whereRef('asset_best_photo_score.assetId', '=', 'asset.id'),
                ),
              ),
              eb.exists(
                eb
                  .selectFrom('asset_best_photo_score')
                  .whereRef('asset_best_photo_score.assetId', '=', 'asset.id')
                  .where('asset_best_photo_score.scoreVersion', '<', options.scoreVersion),
              ),
            ]),
          ),
        )
    );
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForBestPhotoScoring(id: string) {
    return this.db
      .selectFrom('asset')
      .where(libraryScopePredicate(LibraryScope.Personal))
      .select((eb) => [
        'asset.id',
        'asset.ownerId',
        'asset.type',
        'asset.status',
        'asset.deletedAt',
        'asset.visibility',
        'asset.originalFileName',
        'asset.width',
        'asset.height',
        withFilePath(eb, AssetFileType.Preview).as('previewFile'),
        sql<number>`(
          select count(*)
          from asset_face
          where asset_face."assetId" = asset.id
            and asset_face."deletedAt" is null
            and asset_face."isVisible" is true
        )`.as('faceCount'),
        // FL-978: the visual search embedding feeds the learned aesthetic head
        eb
          .selectFrom('smart_search')
          .select('smart_search.embedding')
          .whereRef('smart_search.assetId', '=', 'asset.id')
          .as('embedding'),
        // FL-978: an embedding-only re-score reuses the stored image statistics
        eb
          .selectFrom('asset_best_photo_score')
          .select('asset_best_photo_score.metadata')
          .whereRef('asset_best_photo_score.assetId', '=', 'asset.id')
          .as('scoreMetadata'),
      ])
      .where('asset.id', '=', id)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  getForSyncAssets(ids: string[]) {
    return this.db
      .selectFrom('asset')
      .select([
        'asset.id',
        'asset.isOffline',
        'asset.libraryId',
        'asset.originalPath',
        'asset.status',
        'asset.fileModifiedAt',
      ])
      .where('asset.id', '=', anyUuid(ids))
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForAssetDeletion(id: string) {
    return this.db
      .selectFrom('asset')
      .select([
        'asset.id',
        'asset.type',
        'asset.visibility',
        'asset.libraryId',
        'asset.ownerId',
        'asset.livePhotoVideoId',
        'asset.originalPath',
        'asset.physicalOriginalFileId',
        'asset.checksum',
        'asset.originalFileName',
        'asset.isOffline',
        'asset.deletedAt',
      ])
      .$call(withExif)
      .select(withFiles)
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom('stack')
            .whereRef('stack.id', '=', 'asset.stackId')
            .select((eb) => [
              'stack.id',
              'stack.primaryAssetId',
              jsonArrayFrom(
                eb
                  .selectFrom('asset as stack_asset')
                  .select(['stack_asset.id'])
                  .whereRef('stack_asset.stackId', '=', 'stack.id')
                  .whereRef('stack_asset.id', '!=', 'stack.primaryAssetId')
                  .where('stack_asset.visibility', '=', sql.val(AssetVisibility.Timeline))
                  .where('stack_asset.status', '!=', sql.val(AssetStatus.Deleted)),
              ).as('assets'),
            ])
            .as('stack_result'),
        (join) => join.onTrue(),
      )
      .select((eb) =>
        eb.fn
          .toJson(eb.table('stack_result'))
          .$castTo<{ id: string; primaryAssetId: string; assets: { id: string }[] } | null>()
          .as('stack'),
      )
      .where('asset.id', '=', id)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [], stream: true })
  streamForVideoConversion(force?: boolean) {
    return this.selectionForVideoConversion(force).stream();
  }

  selectionForVideoConversion(force?: boolean) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id'])
      .where('asset.type', '=', sql.lit(AssetType.Video))
      .$if(!force, (qb) =>
        qb
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom('asset_file')
                  .select('asset_file.id')
                  .whereRef('asset_file.assetId', '=', 'asset.id')
                  .where('asset_file.type', '=', sql.lit(AssetFileType.EncodedVideo)),
              ),
            ),
          )
          .where('asset.visibility', '!=', sql.lit(AssetVisibility.Hidden)),
      )
      .where('asset.deletedAt', 'is', null);
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForVideoConversion(id: string) {
    return (
      this.db
        .selectFrom('asset')
        .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
        .innerJoin('asset_video', 'asset_video.assetId', 'asset.id')
        .leftJoin('asset_audio', 'asset_audio.assetId', 'asset.id')
        // `checksum` identifies the exact original an edited master was rendered from (FL-39 lineage).
        .select(['asset.id', 'asset.ownerId', 'asset.originalPath', 'asset.checksum'])
        // FL-968: a raw 360° layout is stitched on the way to the playback copy
        .select(['asset_exif.projectionType', 'asset_exif.make', 'asset_exif.model'])
        .select(withFiles)
        .select((eb) => withAudioStream(eb).as('audioStream'))
        .select((eb) => withVideoStream(eb).$notNull().as('videoStream'))
        .select((eb) => withVideoFormat(eb).$notNull().as('format'))
        .where('asset.id', '=', id)
        .where('asset.type', '=', sql.lit(AssetType.Video))
        .executeTakeFirst()
    );
  }

  @GenerateSql({ params: [], stream: true })
  streamForMetadataExtraction(force?: boolean) {
    return this.selectionForMetadataExtraction(force).stream();
  }

  selectionForMetadataExtraction(force?: boolean, encodingBackfill = false, verifyExif = false) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id'])
      .$if(!force, (qb) =>
        qb.leftJoin('asset_job_status', 'asset_job_status.assetId', 'asset.id').where((eb) => {
          const conditions = [
            eb('asset_job_status.metadataExtractedAt', 'is', null),
            eb('asset_job_status.assetId', 'is', null),
          ];
          if (verifyExif) {
            conditions.push(
              eb.not(eb.exists(eb.selectFrom('asset_exif').select('assetId').whereRef('assetId', '=', 'asset.id'))),
            );
          }
          if (encodingBackfill) {
            // Neither sensor data nor a design file (FL-1358) has an encoding to inspect.
            const raw = Object.keys({ ...mimeTypes.raw, ...mimeTypes.design }).map((extension) =>
              sql.lit(`%${extension}`),
            );
            conditions.push(
              eb.and([
                eb('asset.type', '=', sql.lit(AssetType.Image)),
                sql<boolean>`lower(asset."originalFileName") not like all(array[${sql.join(raw)}]::text[])`,
                eb.not(
                  eb.exists(
                    eb
                      .selectFrom('asset_exif')
                      .whereRef('assetId', '=', 'asset.id')
                      .where('imageEncoding', 'is not', null),
                  ),
                ),
              ]),
            );
          }
          return eb.or(conditions);
        }),
      )
      .where('asset.deletedAt', 'is', null);
  }

  private storageTemplateAssetQuery() {
    return this.db
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
      .select([
        'asset.id',
        'asset.ownerId',
        'asset.type',
        'asset.checksum',
        'asset.originalPath',
        'asset.libraryPath',
        'asset.physicalOriginalFileId',
        'asset.isExternal',
        'asset.visibility',
        'asset.originalFileName',
        'asset.livePhotoVideoId',
        'asset.fileCreatedAt',
        'asset_exif.timeZone',
        'asset_exif.fileSizeInByte',
        'asset_exif.make',
        'asset_exif.model',
        'asset_exif.lensModel',
      ])
      .select((eb) => withFiles(eb, AssetFileType.Sidecar))
      .where('asset.deletedAt', 'is', null);
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForStorageTemplateJob(id: string, options?: { includeHidden?: boolean }) {
    return this.storageTemplateAssetQuery()
      .where('asset.id', '=', id)
      .$if(!options?.includeHidden, (qb) => qb.where('asset.visibility', '!=', AssetVisibility.Hidden))
      .executeTakeFirst();
  }

  @GenerateSql({ params: [], stream: true })
  streamForStorageTemplateJob() {
    return this.storageTemplateAssetQuery().where('asset.visibility', '!=', AssetVisibility.Hidden).stream();
  }

  /**
   * Everything whose trash period is over. An external original the library scan found missing is
   * `active` with a deletion date and `isOffline`: it is the scan's to bring back (or to keep marking),
   * never the trash's to purge, so it stays out of here until the owner trashes it themselves.
   */
  @GenerateSql({ params: [DummyValue.DATE], stream: true })
  streamForDeletedJob(trashedBefore: Date) {
    return this.db
      .selectFrom('asset')
      .select(['id', 'isOffline'])
      .where('asset.deletedAt', '<=', trashedBefore)
      .where((eb) =>
        eb.or([eb('asset.isOffline', '=', sql.lit(false)), eb('asset.status', '!=', sql.lit(AssetStatus.Active))]),
      )
      .stream();
  }

  @GenerateSql({ params: [], stream: true })
  streamForSidecar(force?: boolean) {
    return this.selectionForSidecar(force).stream();
  }

  selectionForSidecar(force?: boolean) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id'])
      .where('asset.status', '!=', sql.lit(AssetStatus.Deleted))
      .$if(!force, (qb) =>
        qb.where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('asset_file')
                .select('asset_file.id')
                .whereRef('asset_file.assetId', '=', 'asset.id')
                .where('asset_file.type', '=', AssetFileType.Sidecar),
            ),
          ),
        ),
      );
  }

  @GenerateSql({ params: [], stream: true })
  streamForDetectFacesJob(force?: boolean) {
    return this.selectionForDetectFacesJob(force).stream();
  }

  selectionForDetectFacesJob(force?: boolean) {
    return this.assetsWithPreviews()
      .where(libraryScopePredicate(LibraryScope.Personal))
      .$if(force === false, (qb) => qb.where('job_status.facesRecognizedAt', 'is', null))
      .select(['asset.id'])
      .orderBy('asset.fileCreatedAt', 'desc');
  }

  /**
   * FL-1408: whether any of this owner's photos still waits for face detection: what "find the missing
   * ones" would queue, so a file that is offline is not waited for. No @GenerateSql: one probe row.
   */
  async hasFacesToDetect(ownerId: string): Promise<boolean> {
    const row = await this.selectionForDetectFacesJob(false)
      .clearOrderBy()
      .where('asset.ownerId', '=', ownerId)
      .where(sql<boolean>`asset.status = 'active' and not asset."isOffline"`)
      .limit(1)
      .executeTakeFirst();
    return !!row;
  }

  @GenerateSql({ params: [], stream: true })
  streamForOcrJob(force?: boolean) {
    return this.selectionForOcrJob(force).stream();
  }

  selectionForOcrJob(force?: boolean) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id'])
      .$if(!force, (qb) =>
        qb
          .innerJoin('asset_job_status', 'asset_job_status.assetId', 'asset.id')
          .where('asset_job_status.ocrAt', 'is', null),
      )
      .where('asset.deletedAt', 'is', null)
      .where('asset.type', '!=', sql.lit(AssetType.Other))
      .where('asset.visibility', '!=', AssetVisibility.Hidden);
  }

  private selectionForImageEnrichmentTask(force: boolean | undefined, task: 'description' | 'nsfwDetection') {
    return (
      this.assetsWithPreviews()
        .select(['asset.id'])
        .where('asset.type', '=', sql.lit(AssetType.Image))
        // background work includes locked media (owner decision, September 22, 2026): stored visibility only
        .where('asset.visibility', 'in', [sql.lit(AssetVisibility.Archive), sql.lit(AssetVisibility.Timeline)])
        .$if(!force, (qb) =>
          qb.where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom('asset_metadata')
                  .select('asset_metadata.assetId')
                  .whereRef('asset_metadata.assetId', '=', 'asset.id')
                  .where('asset_metadata.key', '=', AssetMetadataKey.MlEnrichment)
                  .where(sql<string>`asset_metadata.value -> ${task} ->> 'status'`, '=', 'success'),
              ),
            ),
          ),
        )
        .orderBy('asset.fileCreatedAt', 'desc')
    );
  }

  @GenerateSql({ params: [], stream: true })
  streamForImageDescriptionJob(force?: boolean) {
    return this.selectionForImageDescriptionJob(force).stream();
  }

  /** How many photos still have no description, counted up to `limit`: the cost of this read stays bounded. */
  async countPhotosWithoutDescription(limit: number): Promise<number> {
    const { count } = await this.db
      .selectFrom(
        this.selectionForImageDescriptionJob(false)
          .clearOrderBy()
          .where('asset.type', '=', sql.lit(AssetType.Image))
          .limit(limit)
          .as('waiting'),
      )
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow();
    return Number(count);
  }

  /** `ownerIds` (FL-1484): only these people's photos, when given. */
  selectionForImageDescriptionJob(force?: boolean, ownerIds?: readonly string[]) {
    // Image descriptions run on photos and videos. A video is described from its reusable moment
    // frames (FL-59), which the description job cuts itself when the video has none yet; duplicate
    // detection is no longer a prerequisite, so videos are not filtered on its frames here.
    return (
      this.assetsWithPreviews()
        .select(['asset.id'])
        // background work includes locked media (owner decision, September 22, 2026): stored visibility only
        .where('asset.visibility', 'in', [sql.lit(AssetVisibility.Archive), sql.lit(AssetVisibility.Timeline)])
        .where('asset.type', 'in', [sql.lit(AssetType.Image), sql.lit(AssetType.Video)])
        .$if(!!ownerIds?.length, (qb) => qb.where('asset.ownerId', 'in', [...ownerIds!]))
        .$if(!force, (qb) =>
          qb.where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom('asset_metadata')
                  .select('asset_metadata.assetId')
                  .whereRef('asset_metadata.assetId', '=', 'asset.id')
                  .where('asset_metadata.key', '=', AssetMetadataKey.MlEnrichment)
                  .where(sql<string>`asset_metadata.value -> 'description' ->> 'status'`, '=', 'success'),
              ),
            ),
          ),
        )
        .orderBy('asset.fileCreatedAt', 'desc')
    );
  }

  /**
   * Select image AND video assets that have a successfully completed description,
   * yielding the asset id, owner id, and the tag array from the description result.
   * Used by the smart-album bulk re-evaluate job.
   *
   * Videos with persisted duplicate frames are included because
   * `ImageEnrichmentService.handleImageDescription` runs on both images and
   * videos (compositing video frames into a grid for the VLM). Filtering on
   * `type = Image` would mean the admin "Re-evaluate all" button could never
   * remove or refresh video memberships in smart albums.
   */
  selectionForSmartAlbumReevaluation() {
    return (
      this.db
        .selectFrom('asset')
        .innerJoin('asset_metadata', (join) =>
          join
            .onRef('asset_metadata.assetId', '=', 'asset.id')
            .on('asset_metadata.key', '=', AssetMetadataKey.MlEnrichment),
        )
        .select([
          'asset.id',
          'asset.ownerId',
          sql<string[]>`COALESCE(asset_metadata.value -> 'description' -> 'result' -> 'tags', '[]'::jsonb)`.as('tags'),
        ])
        .where('asset.deletedAt', 'is', null)
        // background work includes locked media (owner decision, September 22, 2026): stored visibility only
        .where('asset.visibility', 'in', [sql.lit(AssetVisibility.Archive), sql.lit(AssetVisibility.Timeline)])
        .where((eb) =>
          eb.exists((qb) =>
            qb
              .selectFrom('asset_file')
              .whereRef('asset_file.assetId', '=', 'asset.id')
              .where('asset_file.type', '=', sql.lit(AssetFileType.Preview)),
          ),
        )
        .where(sql<string>`asset_metadata.value -> 'description' ->> 'status'`, '=', 'success')
        .orderBy('asset.fileCreatedAt', 'desc')
    );
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getForSmartAlbumReevaluation(id: string) {
    return this.selectionForSmartAlbumReevaluation().where('asset.id', '=', asUuid(id)).executeTakeFirst();
  }

  @GenerateSql({ params: [], stream: true })
  streamForNsfwDetectionJob(force?: boolean) {
    return this.selectionForNsfwDetectionJob(force).stream();
  }

  selectionForNsfwDetectionJob(force?: boolean) {
    return this.selectionForImageEnrichmentTask(force, 'nsfwDetection');
  }

  /**
   * FL-521: how far each reading feature has got, as "N of M read": the photos and videos it reads (with
   * a preview, not deleted or hidden, Locked included as background work is) and how many of them it has
   * finished. Text in photos and Locked detection read photos only.
   */
  async countFeatureProgress(): Promise<Record<'search' | 'faces' | 'text' | 'captions' | 'locked', [number, number]>> {
    const enrichment = (task: string) => sql<boolean>`EXISTS (
      SELECT 1 FROM public.asset_metadata m
      WHERE m."assetId" = a.id AND m.key = ${AssetMetadataKey.MlEnrichment} AND m.value -> ${task} ->> 'status' = 'success'
    )`;
    const { rows } = await sql<Record<string, number>>`
      SELECT
        count(*)::int AS "all",
        count(*) FILTER (WHERE a.type = ${AssetType.Image})::int AS "photos",
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.smart_search s WHERE s."assetId" = a.id))::int AS "search",
        count(*) FILTER (WHERE j."facesRecognizedAt" IS NOT NULL)::int AS "faces",
        count(*) FILTER (WHERE a.type = ${AssetType.Image} AND j."ocrAt" IS NOT NULL)::int AS "text",
        count(*) FILTER (WHERE ${enrichment('description')})::int AS "captions",
        count(*) FILTER (WHERE a.type = ${AssetType.Image} AND ${enrichment('nsfwDetection')})::int AS "locked"
      FROM public.asset a
      JOIN public.asset_job_status j ON j."assetId" = a.id
      WHERE a."deletedAt" IS NULL
        AND a.visibility IN (${AssetVisibility.Archive}, ${AssetVisibility.Timeline})
        AND a.type IN (${AssetType.Image}, ${AssetType.Video})
        AND EXISTS (SELECT 1 FROM public.asset_file f WHERE f."assetId" = a.id AND f.type = ${AssetFileType.Preview})`.execute(
      this.db,
    );
    const row = rows[0];
    return {
      search: [row.search, row.all],
      faces: [row.faces, row.all],
      text: [row.text, row.photos],
      captions: [row.captions, row.all],
      locked: [row.locked, row.photos],
    };
  }

  /**
   * FL-521: the photos and videos behind Editing & playback's status: photos, how many photos and
   * videos have no preview yet (the thumbnail job makes both), videos and how many have a playback
   * copy. FL-537: and how long those videos are, for "about N MB a minute". FL-630: and the space the copies take, from their recorded sizes (each
   * shared file once); copies made before files were recorded are counted in `unsizedCopies`.
   */
  async countMediaCopies(): Promise<{
    photos: number;
    withoutPreview: number;
    videos: number;
    withCopy: number;
    videoMs: number;
    copyMs: number;
    copyBytes: number;
    unsizedCopies: number;
  }> {
    const { rows } = await sql<{
      photos: number;
      withoutPreview: number;
      videos: number;
      withCopy: number;
      videoMs: number;
      copyMs: number;
      copyBytes: number;
      unsizedCopies: number;
    }>`
      SELECT
        count(*) FILTER (WHERE a.type = ${AssetType.Image})::int AS photos,
        count(*) FILTER (WHERE NOT EXISTS (
          SELECT 1 FROM public.asset_file f WHERE f."assetId" = a.id AND f.type = ${AssetFileType.Preview}
        ))::int AS "withoutPreview",
        count(*) FILTER (WHERE a.type = ${AssetType.Video})::int AS videos,
        count(*) FILTER (WHERE a.type = ${AssetType.Video} AND EXISTS (
          SELECT 1 FROM public.asset_file f WHERE f."assetId" = a.id AND f.type = ${AssetFileType.EncodedVideo}
        ))::int AS "withCopy",
        coalesce(sum(a.duration) FILTER (WHERE a.type = ${AssetType.Video}), 0)::float8 AS "videoMs",
        coalesce(sum(a.duration) FILTER (WHERE a.type = ${AssetType.Video} AND EXISTS (
          SELECT 1 FROM public.asset_file f WHERE f."assetId" = a.id AND f.type = ${AssetFileType.EncodedVideo}
        )), 0)::float8 AS "copyMs",
        (SELECT coalesce(sum(p."sizeInBytes"), 0)::float8 FROM public.physical_file p WHERE p.id IN (
          SELECT f."physicalFileId" FROM public.asset_file f JOIN public.asset c ON c.id = f."assetId"
          WHERE f.type = ${AssetFileType.EncodedVideo} AND c."deletedAt" IS NULL
            AND c.visibility != ${AssetVisibility.Hidden}
        )) AS "copyBytes",
        (SELECT count(*) FROM public.asset_file f JOIN public.asset c ON c.id = f."assetId"
          WHERE f.type = ${AssetFileType.EncodedVideo} AND c."deletedAt" IS NULL
            AND c.visibility != ${AssetVisibility.Hidden} AND f."physicalFileId" IS NULL
        )::int AS "unsizedCopies"
      FROM public.asset a
      WHERE a."deletedAt" IS NULL AND a.visibility != ${AssetVisibility.Hidden}
        AND a.type IN (${AssetType.Image}, ${AssetType.Video})`.execute(this.db);
    return rows[0];
  }

  @GenerateSql({ params: [DummyValue.DATE], stream: true })
  streamForMigrationJob() {
    return this.db.selectFrom('asset').select(['id']).where('asset.deletedAt', 'is', null).stream();
  }
}
