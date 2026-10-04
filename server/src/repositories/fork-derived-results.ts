import { Kysely } from 'kysely';
import { createHash } from 'node:crypto';

import { DB } from 'src/schema/index.js';
import { asUuid } from 'src/utils/database.js';

export type TableVerification = { count: number; digest: string };
export type DerivedBackfillResult<Tables extends Record<string, TableVerification>> = TableVerification & {
  tables: Tables;
};

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
};

export const digestValue = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');

export const verifyRows = (rows: unknown[]): TableVerification => ({ count: rows.length, digest: digestValue(rows) });

export const combineVerifications = <T extends Record<string, TableVerification>>(
  processed: number,
  tables: T,
): DerivedBackfillResult<T> => ({ count: processed, digest: digestValue(tables), tables });

export const lockForkAssetParent = async (
  db: Kysely<DB>,
  assetId: string,
): Promise<{ id: string; ownerId: string }> => {
  const asset = await db
    .withSchema('public')
    .selectFrom('asset')
    .select(['id', 'ownerId'])
    .where('id', '=', asUuid(assetId))
    .forKeyShare()
    .executeTakeFirst();
  if (!asset) {
    throw new Error(`Cannot write derived result for missing asset ${assetId}`);
  }
  return asset;
};
