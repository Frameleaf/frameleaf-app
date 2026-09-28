import { Injectable } from '@nestjs/common';
import { type Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import type { LockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { AssetVisibility } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { anyUuid, withAlbumVisibility, withHiddenContentFilter, withLockedOwnerScope } from 'src/utils/database.js';

type DownloadPrivacyOptions = HiddenContentQueryOptions & LockedVisibilityOptions;

const builder = (db: Kysely<DB>, options: DownloadPrivacyOptions = {}) =>
  db
    .selectFrom('asset')
    .innerJoin('asset_exif', 'assetId', 'id')
    .select(['asset.id', 'asset.livePhotoVideoId', 'asset_exif.fileSizeInByte as size'])
    .where('asset.deletedAt', 'is', null)
    .$call((qb) => withHiddenContentFilter(qb, options));

@Injectable()
export class DownloadRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  downloadAssetIds(ids: string[], options?: DownloadPrivacyOptions) {
    return builder(this.db, options).where('asset.id', '=', anyUuid(ids)).stream();
  }

  downloadMotionAssetIds(ids: string[], options?: DownloadPrivacyOptions) {
    return builder(this.db, options).select(['asset.originalPath']).where('asset.id', '=', anyUuid(ids)).stream();
  }

  /** An album download holds the same media the album shows this viewer (see `withAlbumVisibility`). */
  downloadAlbumId(albumId: string, options?: DownloadPrivacyOptions) {
    return builder(this.db, options)
      .innerJoin('album_asset', 'asset.id', 'album_asset.assetId')
      .where('album_asset.albumId', '=', albumId)
      .$call((qb) => withAlbumVisibility(qb, options?.lockedOwnerId))
      .stream();
  }

  /** A whole-library download holds the owner's Locked media only for their elevated session (FL-34). */
  downloadUserId(userId: string, options?: DownloadPrivacyOptions) {
    return builder(this.db, options)
      .where('asset.ownerId', '=', userId)
      .where('asset.visibility', '!=', AssetVisibility.Hidden)
      .$call((qb) => withLockedOwnerScope(qb, options?.lockedOwnerId))
      .stream();
  }
}
