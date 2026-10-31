import { type RawBuilder, sql } from 'kysely';

/**
 * FL-721 (spec §6, §6.3): whether the asset under `alias` is one whose files its owner's Locked
 * encryption covers, once it is Locked: its owner has a `locked_encryption` row (turning on, on or
 * turning off), it isn't on a read-only source (`libraryId IS NOT NULL`, the same rule as the
 * settings page's "not encryptable" count), and it isn't a partner's copy, whose files are the
 * owner's and are sealed through the owner's asset (§6.1, §6.2).
 *
 * Used by every lock writer that has to decide between removing a lock and marking it
 * `pendingUnlockAt` (§7.3: decrypt first, then unlock).
 */
export const encryptsFilesOf = (alias = 'asset'): RawBuilder<boolean> => {
  const asset = sql.ref(alias);
  return sql<boolean>`(
    ${sql.ref(`${alias}.libraryId`)} is null
    and exists (select 1 from public.locked_encryption e where e."userId" = ${sql.ref(`${alias}.ownerId`)})
    and not exists (select 1 from public.asset_origin o where o."assetId" = ${asset}.id)
  )`;
};
