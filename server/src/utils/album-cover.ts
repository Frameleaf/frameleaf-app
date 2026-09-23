import { ExpressionBuilder, sql } from 'kysely';
import { DB } from 'src/schema/index.js';
import { isNotLocked } from 'src/utils/locked.js';

/**
 * The album assets that may serve as its cover. Locked media (FL-34, the lock record) never does (owner decision, September
 * 22, 2026): the cover shows on album lists, in shared links and to other members, none of whom may
 * see it. Trashed media does not either.
 */
export const albumCoverCandidates = (eb: ExpressionBuilder<DB, 'album'>) =>
  eb
    .selectFrom('album_asset')
    .innerJoin('asset', (join) =>
      join
        .onRef('album_asset.assetId', '=', 'asset.id')
        .on('asset.deletedAt', 'is', null)
        .on(isNotLocked('asset')),
    )
    .whereRef('album_asset.albumId', '=', 'album.id');

/** The automatic cover of an album: its newest candidate, or null when it has none. */
export const automaticAlbumCover = (eb: ExpressionBuilder<DB, 'album'>) =>
  albumCoverCandidates(eb).select('album_asset.assetId').orderBy('asset.fileCreatedAt', 'desc').limit(sql.lit(1));
