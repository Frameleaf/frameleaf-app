import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import { columns } from 'src/database.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AssetFileType, AssetMetadataKey, AssetStatus, AssetType, AssetVisibility, LibraryScope } from 'src/enum.js';
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
  withFilePath,
  withFiles,
  withVideoFormat,
  withVideoStream,
} from 'src/utils/database.js';
import { libraryScopePredicate } from 'src/utils/library-scope.js';
import { effectiveVisibility, isLocked, isNotLocked } from 'src/utils/locked.js';
import { mimeTypes } from 'src/utils/mime-types.js';

@Injectable()
export class AssetJobRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {
    this.db = publicationDatabase(this.db);
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
      .select(['id', 'ownerId', 'originalPath', 'physicalOriginalFileId'])
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
      .$if(!options.force, (qb) =>
        qb
          // If there aren't any entries, metadata extraction hasn't run yet which is required for thumbnails
          .innerJoin('asset_job_status', 'asset_job_status.assetId', 'asset.id')
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
                  eb(sql`f_unaccent(asset."originalFileName")`, 'like', sql`any(array[${isWebUnsupported}]::text[])`),
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
      .select(withFaces)
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
    return this.db
      .selectFrom('asset')
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
        .select((eb) => withFiles(eb, AssetFileType.Preview))
        .where('asset.id', '=', id)
        .executeTakeFirst()
    );
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

  selectionForMetadataExtraction(force?: boolean, encodingBackfill = false) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id'])
      .$if(!force, (qb) =>
        qb.leftJoin('asset_job_status', 'asset_job_status.assetId', 'asset.id').where((eb) => {
          const conditions = [
            eb('asset_job_status.metadataExtractedAt', 'is', null),
            eb('asset_job_status.assetId', 'is', null),
          ];
          if (encodingBackfill) {
            const raw = Object.keys(mimeTypes.raw).map((extension) => sql.lit(`%${extension}`));
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

  @GenerateSql({ params: [DummyValue.DATE], stream: true })
  streamForDeletedJob(trashedBefore: Date) {
    return this.db
      .selectFrom('asset')
      .select(['id', 'isOffline'])
      .where('asset.deletedAt', '<=', trashedBefore)
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

  selectionForImageDescriptionJob(force?: boolean) {
    // Image descriptions run on photos and videos. A video is described from its reusable moment
    // frames (FL-59), which the description job cuts itself when the video has none yet; duplicate
    // detection is no longer a prerequisite, so videos are not filtered on its frames here.
    return (
      this.assetsWithPreviews()
        .select(['asset.id'])
        // background work includes locked media (owner decision, September 22, 2026): stored visibility only
        .where('asset.visibility', 'in', [sql.lit(AssetVisibility.Archive), sql.lit(AssetVisibility.Timeline)])
        .where('asset.type', 'in', [sql.lit(AssetType.Image), sql.lit(AssetType.Video)])
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
   * FL-521: the photos and videos behind Editing & playback's status: photos and how many have no
   * preview yet, videos and how many have a playback copy. FL-537: and how long those videos are, for
   * "about N MB a minute". FL-630: and the space the copies take, from their recorded sizes (each
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
        count(*) FILTER (WHERE a.type = ${AssetType.Image} AND NOT EXISTS (
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
