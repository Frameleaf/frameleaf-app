import { type Kysely, type Transaction, sql } from 'kysely';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DB as DatabaseSchema } from 'src/schema/index.js';
import { AssetType } from 'src/enum.js';
import { lockSourceAuthorities } from 'src/utils/source-authority-lock.js';
import { parseSourceOriginalPath } from 'src/utils/source-original.js';

/** Only DB-only adoption callbacks enter this scope. No executor holds a transaction during I/O. */
export const publicationTransaction = new AsyncLocalStorage<Transaction<DatabaseSchema>>();

/**
 * Participating repositories resolve their connection when building a query. A nested repository
 * transaction joins the publication transaction; errors propagate and roll back the entire claim.
 * The adapter never mutates a shared repository, so unrelated API calls keep their own connection.
 */
export function publicationDatabase<DB>(database: Kysely<DB>): Kysely<DB> {
  return new Proxy(database, {
    get(target, property) {
      const transaction = publicationTransaction.getStore();
      const current = transaction ?? target;
      if (transaction && property === 'transaction') {
        return () => ({
          execute: <T>(callback: (tx: Transaction<DB>) => Promise<T>) =>
            callback(transaction as unknown as Transaction<DB>),
        });
      }
      const value = Reflect.get(current, property, current);
      return typeof value === 'function' ? value.bind(current) : value;
    },
  });
}

async function lockPublicationAssets(tx: Transaction<DatabaseSchema>, assetIds: string[], ownerId?: string) {
  const ids = [...new Set(assetIds)].sort();
  const hints = await tx.selectFrom('asset').select(['id', 'ownerId', 'originalPath']).where('id', 'in', ids).execute();
  if (ownerId && hints.some((asset) => asset.ownerId !== ownerId)) throw new Error('Prepared output source changed');
  const authorities = hints.flatMap((asset) => {
    const identity = parseSourceOriginalPath(asset.originalPath);
    return identity ? [{ sourceId: identity.sourceId, ownerId: asset.ownerId }] : [];
  });
  if (!(await lockSourceAuthorities(tx, authorities))) throw new Error('Prepared output source authority changed');
  for (const id of ids) await sql`select pg_advisory_xact_lock(-1, hashtext(${id})::int)`.execute(tx);
  const assets = await tx
    .selectFrom('asset')
    .select(['id', 'ownerId', 'originalPath', 'livePhotoVideoId', 'checksum', 'deletedAt', 'isOffline', 'type'])
    .where('id', 'in', ids)
    .orderBy('id')
    .forUpdate()
    .execute();
  if (
    assets.length !== hints.length ||
    assets.some((asset) =>
      hints.every(
        (hint) => !(hint.id === asset.id && hint.ownerId === asset.ownerId && hint.originalPath === asset.originalPath),
      ),
    )
  )
    throw new Error('Prepared output source changed');
  return assets;
}

/** Lock the source identity only during adoption; a replaced original invalidates prepared output. */
export async function assertPublicationSource(assetId: string, checksum: Buffer, ownerId?: string) {
  const tx = publicationTransaction.getStore();
  if (!tx) {
    return;
  }
  const [asset] = await lockPublicationAssets(tx, [assetId], ownerId);
  if (!asset || !Buffer.from(asset.checksum).equals(checksum)) {
    throw new Error('Prepared output source changed');
  }
}

/** Lock both sides of a Live Photo relationship before adopting pixels from its motion source. */
export async function assertPublicationMotionSource(
  stillId: string,
  ownerId: string,
  stillChecksum: Buffer,
  motionId: string,
  checksum: Buffer,
) {
  const tx = publicationTransaction.getStore();
  if (!tx) throw new Error('Motion publication requires a database transaction');
  const assets = await lockPublicationAssets(tx, [stillId, motionId]);
  const still = assets.find((asset) => asset.id === stillId);
  const motion = assets.find((asset) => asset.id === motionId);
  const locked = await tx.selectFrom('asset_lock').select('assetId').where('assetId', '=', motionId).executeTakeFirst();
  if (
    !still ||
    !motion ||
    still.ownerId !== ownerId ||
    motion.ownerId !== ownerId ||
    !Buffer.from(still.checksum).equals(stillChecksum) ||
    still.deletedAt ||
    still.livePhotoVideoId !== motionId ||
    motion.type !== AssetType.Video ||
    motion.deletedAt ||
    motion.isOffline ||
    locked ||
    !Buffer.from(motion.checksum).equals(checksum)
  )
    throw new Error('Prepared motion source changed or became unavailable');
}
