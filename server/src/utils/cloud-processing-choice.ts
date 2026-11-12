import { ForbiddenException } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import type { DB } from 'src/schema/index.js';
import { MediaOperationDestination, UserMetadataKey } from 'src/enum.js';

/**
 * FL-1484: each person chooses whether AI work on their own photos may use Frameleaf Cloud (Your preferences ›
 * Where your photos are processed). Someone who keeps their photos at home has `cloudProcessing.enabled` false.
 */
export const CLOUD_PROCESSING_KEPT_HOME =
  'These photos stay at home: their owner keeps AI work off Frameleaf Cloud in Where your photos are processed';

/** Of `userIds` (everyone when not given), the people who keep their photos at home. */
export const cloudProcessingOptOuts = async (db: Kysely<DB>, userIds?: readonly string[]): Promise<Set<string>> => {
  const ids = userIds && [...new Set(userIds)];
  if (ids?.length === 0) {
    return new Set();
  }
  const rows = await db
    .selectFrom('user_metadata')
    .select('userId')
    .$if(!!ids, (qb) => qb.where('userId', 'in', ids!))
    .where('key', '=', UserMetadataKey.Preferences)
    .where(sql<boolean>`"value" -> 'cloudProcessing' ->> 'enabled' = 'false'`)
    .execute();
  return new Set(rows.map((row) => row.userId));
};

const snapshotAssetIds = (snapshot: unknown): string[] => {
  if (!snapshot || typeof snapshot !== 'object') {
    return [];
  }
  const { assetId, assetIds } = snapshot as { assetId?: unknown; assetIds?: unknown };
  return [
    ...(typeof assetId === 'string' ? [assetId] : []),
    ...(Array.isArray(assetIds) ? assetIds.filter((id): id is string => typeof id === 'string') : []),
  ];
};

/**
 * The last check before any Frameleaf Cloud work is recorded: refused when its owner, or the owner of any photo
 * it names, keeps their photos at home. Work on this server or a computer at home is never refused here.
 */
export const assertCloudProcessingAllowed = async (
  db: Kysely<DB>,
  operation: { destination: string; ownerId: string; assetId?: string | null; snapshot?: unknown },
): Promise<void> => {
  if (operation.destination !== MediaOperationDestination.FrameleafCloud) {
    return;
  }
  const assetIds = [
    ...new Set([...(operation.assetId ? [operation.assetId] : []), ...snapshotAssetIds(operation.snapshot)]),
  ];
  const assetOwners =
    assetIds.length === 0
      ? []
      : (await db.selectFrom('asset').select('ownerId').where('id', 'in', assetIds).execute()).map(
          (row) => row.ownerId,
        );
  const kept = await cloudProcessingOptOuts(db, [operation.ownerId, ...assetOwners]);
  if (kept.size > 0) {
    throw new ForbiddenException(CLOUD_PROCESSING_KEPT_HOME);
  }
};
