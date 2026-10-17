import { ConflictException, Injectable } from '@nestjs/common';
import { Kysely, type SqlBool, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { AssetType, AssetVisibility } from 'src/enum.js';
import { publicationDatabase } from 'src/queue/transaction.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DB } from 'src/schema/index.js';
import { asUuid } from 'src/utils/database.js';
import { isNotLocked } from 'src/utils/locked.js';

export type LivePhotoCandidateRow = {
  photoId: string;
  videoId: string;
};

// A separated live photo's parts are still visible in the library (timeline or
// archive). Hidden and locked (FL-34, the lock record) assets are intentionally excluded.
const VISIBLE_STATES = [AssetVisibility.Timeline, AssetVisibility.Archive];

// Lowercased filename with its extension stripped (e.g. `IMG_1234.HEIC` -> `img_1234`).
const filenameStem = (column: string) => sql<string>`lower(regexp_replace(${sql.ref(column)}, '\\.[^.]+$', ''))`;

@Injectable()
export class LivePhotoRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {
    this.db = publicationDatabase(this.db);
  }

  async withRelinkTransaction<T>(
    photoId: string,
    videoId: string,
    callback: (assets: AssetRepository, albums: AlbumRepository) => Promise<T>,
  ): Promise<T> {
    const execute = async (tx: Kysely<DB>) => {
      const assetIds = [...new Set([photoId.toLowerCase(), videoId.toLowerCase()])].sort();
      for (const id of assetIds) {
        await sql`SELECT pg_advisory_xact_lock(-1, hashtext(${id})::int)`.execute(tx);
      }
      const memberships = await tx.selectFrom('album_asset').select('albumId').where('assetId', '=', videoId).execute();
      const albumIds = new Set(memberships.map(({ albumId }) => albumId));
      try {
        // Album writers take album rows before asset/FK locks; refuse contention rather than invert that order.
        if (albumIds.size > 0) {
          await tx
            .selectFrom('album')
            .select('id')
            .where('id', 'in', [...albumIds].sort())
            .orderBy('id')
            .forNoKeyUpdate()
            .noWait()
            .execute();
        }
        await tx
          .selectFrom('asset')
          .select('id')
          .where('id', 'in', assetIds)
          .orderBy('id')
          .forUpdate()
          .noWait()
          .execute();
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === '55P03') {
          throw new ConflictException('The pair or its album membership is changing; retry relinking.');
        }
        throw error;
      }
      const current = await tx.selectFrom('album_asset').select('albumId').where('assetId', '=', videoId).execute();
      if (current.some(({ albumId }) => !albumIds.has(albumId))) {
        throw new ConflictException('The pair or its album membership is changing; retry relinking.');
      }
      return callback(new AssetRepository(tx), new AlbumRepository(tx));
    };
    return this.db.isTransaction ? execute(this.db) : this.db.transaction().execute(execute);
  }

  /**
   * High-confidence candidates: a still image and a video that share Apple's
   * embedded ContentIdentifier (`asset_exif.livePhotoCID`) but are not linked.
   * This is the same key immich uses to link live photos during ingestion.
   */
  getUnlinkedByContentId(ownerId: string): Promise<LivePhotoCandidateRow[]> {
    return this.db
      .selectFrom('asset as photo')
      .innerJoin('asset_exif as photo_exif', 'photo_exif.assetId', 'photo.id')
      .innerJoin('asset_exif as video_exif', 'video_exif.livePhotoCID', 'photo_exif.livePhotoCID')
      .innerJoin('asset as video', 'video.id', 'video_exif.assetId')
      .select(['photo.id as photoId', 'video.id as videoId'])
      .where('photo.ownerId', '=', asUuid(ownerId))
      .whereRef('video.ownerId', '=', 'photo.ownerId')
      .where('photo.type', '=', AssetType.Image)
      .where('video.type', '=', AssetType.Video)
      .where('photo.livePhotoVideoId', 'is', null)
      .where('photo_exif.livePhotoCID', 'is not', null)
      .where('photo.deletedAt', 'is', null)
      .where('video.deletedAt', 'is', null)
      .where('photo.visibility', 'in', VISIBLE_STATES)
      .where('video.visibility', 'in', VISIBLE_STATES)
      .where(isNotLocked('photo'))
      .where(isNotLocked('video'))
      .where((eb) =>
        eb.not(
          eb.exists(
            eb.selectFrom('asset as linked').select('linked.id').whereRef('linked.livePhotoVideoId', '=', 'video.id'),
          ),
        ),
      )
      .execute();
  }

  /**
   * Low-confidence fallback for files whose ContentIdentifier was stripped: a
   * still image and a video owned by the same user that share the same filename
   * stem (e.g. `IMG_1234.HEIC` / `IMG_1234.MOV`) and were captured within
   * `windowSeconds` of each other.
   */
  getUnlinkedByFilename(ownerId: string, windowSeconds: number): Promise<LivePhotoCandidateRow[]> {
    return this.db
      .selectFrom('asset as photo')
      .innerJoin('asset as video', (join) =>
        join
          .onRef('video.ownerId', '=', 'photo.ownerId')
          .on(sql<SqlBool>`${filenameStem('photo.originalFileName')} = ${filenameStem('video.originalFileName')}`)
          .on(
            sql<SqlBool>`abs(extract(epoch from (${sql.ref('photo.fileCreatedAt')} - ${sql.ref('video.fileCreatedAt')}))) <= ${windowSeconds}`,
          ),
      )
      .select(['photo.id as photoId', 'video.id as videoId'])
      .where('photo.ownerId', '=', asUuid(ownerId))
      .where('photo.type', '=', AssetType.Image)
      .where('video.type', '=', AssetType.Video)
      .where('photo.livePhotoVideoId', 'is', null)
      .where('photo.deletedAt', 'is', null)
      .where('video.deletedAt', 'is', null)
      .where('photo.visibility', 'in', VISIBLE_STATES)
      .where('video.visibility', 'in', VISIBLE_STATES)
      .where(isNotLocked('photo'))
      .where(isNotLocked('video'))
      .where((eb) =>
        eb.not(
          eb.exists(
            eb.selectFrom('asset as linked').select('linked.id').whereRef('linked.livePhotoVideoId', '=', 'video.id'),
          ),
        ),
      )
      .execute();
  }
}
