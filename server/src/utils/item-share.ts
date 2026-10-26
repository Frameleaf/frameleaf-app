import { Kysely } from 'kysely';
import { DB } from 'src/schema/index.js';
import { anyUuid, hiddenByOwnerRules } from 'src/utils/database.js';

/**
 * Re-read owners’ current Locked rules: sharing never freezes the privacy policy at creation. A Studio
 * export is hidden wherever its source is (FL-447).
 */
export const getOwnerHiddenShareIds = async (db: Kysely<DB>, assets: { id: string }[]) => {
  if (assets.length === 0) {
    return new Set<string>();
  }
  const hidden = await db
    .selectFrom('asset')
    .select('asset.id')
    .where('asset.id', '=', anyUuid(assets.map(({ id }) => id)))
    .where(hiddenByOwnerRules())
    .execute();
  return new Set(hidden.map(({ id }) => id));
};
