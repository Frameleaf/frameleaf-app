import { type Kysely, type Transaction, sql } from 'kysely';
import { AsyncLocalStorage } from 'node:async_hooks';
import { AssetType } from 'src/enum.js';

/** Only DB-only adoption callbacks enter this scope. No executor holds a transaction during I/O. */
export const publicationTransaction = new AsyncLocalStorage<Transaction<any>>();

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

/** Lock the source identity only during adoption; a replaced original invalidates prepared output. */
export async function assertPublicationSource(assetId: string, checksum: Buffer) {
  const tx = publicationTransaction.getStore();
  if (!tx) {
    return;
  }
  await sql`select pg_advisory_xact_lock(-1, hashtext(${assetId})::int)`.execute(tx);
  const asset = await tx
    .selectFrom('asset')
    .select('checksum')
    .where('id', '=', assetId)
    .forUpdate()
    .executeTakeFirst();
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
  for (const id of [stillId, motionId].sort())
    await sql`select pg_advisory_xact_lock(-1, hashtext(${id})::int)`.execute(tx);
  const assets = await tx
    .selectFrom('asset')
    .select(['id', 'ownerId', 'livePhotoVideoId', 'checksum', 'deletedAt', 'isOffline', 'type'])
    .where('id', 'in', [stillId, motionId])
    .orderBy('id')
    .forUpdate()
    .execute();
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
