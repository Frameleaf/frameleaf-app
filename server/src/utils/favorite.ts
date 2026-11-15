import { sql } from 'kysely';

/**
 * FL-786: whether `viewerId` favourited the asset `alias`: the owner's own heart (`isFavorite`), or for anyone else
 * the heart they gave it through a shared album or space. An owner's favourites are never anyone else's.
 */
export const favoriteFor = (
  viewerId: string,
  alias = 'asset',
) => sql<boolean>`((${sql.ref(`${alias}.ownerId`)} = ${viewerId}::uuid
  AND ${sql.ref(`${alias}.isFavorite`)})
  OR EXISTS (SELECT 1 FROM public.asset_favorite af
    WHERE af."assetId" = ${sql.ref(`${alias}.id`)} AND af."userId" = ${viewerId}::uuid))`;
