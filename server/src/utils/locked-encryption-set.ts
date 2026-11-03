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

/**
 * FL-721 (spec §6.1): whether the original the asset under `alias` reads is, or is about to be,
 * encrypted: a Locked item whose owner's encryption covers it reads the same file (the item itself,
 * a partner's copy of it, or a plain reader still waiting for the un-share before the seal). That
 * includes the copy an un-share made, which only the encrypted item reads. Deduplication never links
 * into or out of such a file: an upload or the identical-files engine keeps its own copy instead.
 * Checksums stay plaintext checksums, so duplicate detection still finds them.
 */
export const holdsEncryptedOriginal = (alias = 'asset'): RawBuilder<boolean> =>
  sql<boolean>`exists (
    select 1 from public.asset sealed
    join public.asset_lock sealed_lock on sealed_lock."assetId" = sealed.id
    where (
      sealed."originalPath" = ${sql.ref(`${alias}.originalPath`)}
      or sealed."physicalOriginalFileId" = ${sql.ref(`${alias}.physicalOriginalFileId`)}
    )
    and ${encryptsFilesOf('sealed')}
  )`;

/** `holdsEncryptedOriginal` for a stored file's path rather than an asset. */
export const isEncryptedOriginalPath = (path: string): RawBuilder<boolean> =>
  sql<boolean>`exists (
    select 1 from public.asset sealed
    join public.asset_lock sealed_lock on sealed_lock."assetId" = sealed.id
    where sealed."originalPath" = ${path} and ${encryptsFilesOf('sealed')}
  )`;
