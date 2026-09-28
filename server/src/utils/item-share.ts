import { Kysely, sql } from 'kysely';
import { UserMetadataKey } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { anyUuid, hiddenContentAssetIdExists } from 'src/utils/database.js';
import { hasHiddenContentFilter } from 'src/utils/hidden-content.js';
import { getPreferences } from 'src/utils/preferences.js';

/** Re-read owners’ current Locked rules: sharing never freezes the privacy policy at creation. */
export const getOwnerHiddenShareIds = async (db: Kysely<DB>, assets: { id: string; ownerId: string }[]) => {
  if (assets.length === 0) {
    return new Set<string>();
  }
  const metadata = await db
    .selectFrom('user_metadata')
    .select(['userId', 'key', 'value'])
    .where('userId', '=', anyUuid([...new Set(assets.map(({ ownerId }) => ownerId))]))
    .where('key', '=', UserMetadataKey.Preferences)
    .execute();
  const filters = metadata
    .map((row) => ({ ...getPreferences([row]).privacy.suppression, userId: row.userId, includeNsfw: false }))
    .filter(hasHiddenContentFilter);
  if (filters.length === 0) {
    return new Set<string>();
  }
  const hidden = await db
    .selectFrom('asset')
    .select('asset.id')
    .where('asset.id', '=', anyUuid(assets.map(({ id }) => id)))
    .where(
      sql<boolean>`(${sql.join(
        filters.map(
          (filter) =>
            sql<boolean>`(asset."ownerId" = ${filter.userId}::uuid and ${hiddenContentAssetIdExists(sql.ref('asset.id'), filter)})`,
        ),
        sql` or `,
      )})`,
    )
    .execute();
  return new Set(hidden.map(({ id }) => id));
};
