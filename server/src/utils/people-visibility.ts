import { type RawBuilder, sql } from 'kysely';
import { AssetVisibility, UserMetadataKey } from 'src/enum.js';
import { isTimelineVisible, visibilityIs } from 'src/utils/locked.js';

/**
 * FL-795: whether `userId` lets archived photos into People (Your preferences › Tools & sidebar ›
 * People options › Include archived photos). Off unless they turned it on, so People shows timeline
 * photos only, as it did before the option existed. `userId` is a value or a column (`sql.ref`).
 */
export const peopleIncludeArchived = (userId: string | RawBuilder<unknown>) =>
  sql<boolean>`coalesce((
    select (user_metadata.value -> 'people' ->> 'includeArchived')::boolean
    from user_metadata
    where user_metadata."userId" = ${userId} and user_metadata.key = ${sql.lit(UserMetadataKey.Preferences)}
  ), false)`;

/**
 * A photo as People shows it to `viewerId`: on the timeline, or archived when the viewer includes
 * archived photos. Locked photos never qualify (see `visibilityIs`).
 */
export const isPeopleVisible = (viewerId: string, assetAlias = 'asset', revealOwnerId?: string) =>
  sql<boolean>`(${isTimelineVisible(assetAlias, revealOwnerId)} or (${visibilityIs(AssetVisibility.Archive, assetAlias, revealOwnerId)} and ${peopleIncludeArchived(viewerId)}))`;

/**
 * For a featured face (one picked for a person automatically): an archived photo only when the
 * person's owner includes archived photos in People. Other visibilities are left to the caller.
 */
export const archivedAllowedInPeople = (ownerId: string | RawBuilder<unknown>, assetAlias = 'asset') =>
  sql<boolean>`(${sql.ref(`${assetAlias}.visibility`)} != ${sql.lit(AssetVisibility.Archive)} or ${peopleIncludeArchived(ownerId)})`;
