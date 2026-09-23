import { ExpressionBuilder } from 'kysely';
import { DB } from 'src/schema/index.js';
import { isNotLocked } from 'src/utils/locked.js';

/**
 * The album assets that may serve as its cover. Locked media (the lock record, FL-34) never does
 * (owner decision, September 22, 2026): the cover shows on album lists, in shared links and to other
 * members, none of whom may see it. Trashed media does not either.
 */
export const albumCoverCandidates = (eb: ExpressionBuilder<DB, 'album'>) =>
  eb
    .selectFrom('album_asset')
    .innerJoin('asset', (join) =>
      join.onRef('album_asset.assetId', '=', 'asset.id').on('asset.deletedAt', 'is', null).on(isNotLocked('asset')),
    )
    .whereRef('album_asset.albumId', '=', 'album.id');

// The automatic cover an album takes (which candidate, in what order) is `albumCoverReplacement` in
// `src/utils/cover-references.ts`: Best Photos first, then newest, never sensitive for an album anyone
// besides its owner sees. `AlbumRepository.updateThumbnails` uses it directly so there is one picker,
// not two that could disagree (FL-53).
