import { ExpressionBuilder, Kysely, sql } from 'kysely';
import { AssetVisibility } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { anyUuid } from 'src/utils/database.js';

/**
 * The album assets that may serve as its cover. Locked media never does (owner decision, September
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
        .on('asset.visibility', '!=', sql.lit(AssetVisibility.Locked)),
    )
    .whereRef('album_asset.albumId', '=', 'album.id');

/** The automatic cover of an album: its newest candidate, or null when it has none. */
export const automaticAlbumCover = (eb: ExpressionBuilder<DB, 'album'>) =>
  albumCoverCandidates(eb).select('album_asset.assetId').orderBy('asset.fileCreatedAt', 'desc').limit(sql.lit(1));

/**
 * Album covers are never Locked photos (owner decision, September 22, 2026, FL-53). When any of
 * `assetIds` is now Locked and is the cover of an album, it stops being that album's cover and the
 * album falls back to its automatic cover, which is never Locked; with no candidate left the album
 * has no cover. Every album that uses it is repaired, whoever owns the album.
 *
 * Call it after the visibility change and in the same transaction, so the cover and the Locked flag
 * never disagree: it must be a separate statement from the asset update, because a statement does
 * not see the rows another part of the same statement changes and would pick the asset again.
 * Unaffected ids are ignored, so it is safe after any update.
 */
export const releaseLockedAlbumCovers = async (db: Kysely<DB>, assetIds: string[]): Promise<void> => {
  if (assetIds.length === 0) {
    return;
  }

  await db
    .updateTable('album')
    .set((eb) => ({ albumThumbnailAssetId: automaticAlbumCover(eb) }))
    .where('album.albumThumbnailAssetId', '=', anyUuid(assetIds))
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('asset')
          .select(sql`1`.as('1'))
          .whereRef('asset.id', '=', 'album.albumThumbnailAssetId')
          .where('asset.visibility', '=', sql.lit(AssetVisibility.Locked)),
      ),
    )
    .execute();
};
