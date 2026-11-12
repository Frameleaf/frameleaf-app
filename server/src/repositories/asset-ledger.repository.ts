import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { AssetLedgerState } from 'src/schema/tables/asset-ledger.table.js';
import { DB } from 'src/schema/index.js';
import { anyUuid } from 'src/utils/database.js';

/** How an original arrived. Text, not an enum: new ways are added without a schema change. */
export type AssetLedgerAddedVia =
  'upload' | 'library-scan' | 'import' | 'partner-copy' | 'studio' | 'recovered' | 'unknown';

/** Why a row is in its state. */
export type AssetLedgerReason =
  'deleted' | 'trash-expired' | 'removed' | 'account-removed' | 'identical-file' | 'not-found' | 'found';

export type AssetLedgerRow = {
  assetId: string;
  checksum: Buffer;
  originalFileName: string;
  addedAt: Date;
  addedVia: string;
  state: AssetLedgerState;
  stateAt: Date;
  stateBy: string | null;
  reason: string | null;
  /** `stateAt` as the database wrote it, to the microsecond, for the next page's cursor. */
  cursorAt: string;
};

export type AssetLedgerCounts = Record<AssetLedgerState, number>;

type Change = { by?: string | null; reason?: AssetLedgerReason | null };

/** The state the photo's own row says it is in. A file found missing by a library scan is still kept. */
const stateOfAsset = sql`case a.status when 'trashed' then 'trashed' when 'deleted' then 'removed' else 'kept' end`;

/**
 * A photo that is back among the kept ones shares an identical file when its link was never undone
 * (`identical_file_change`), and is plainly kept otherwise.
 */
const keptState = sql`case when exists (
    select 1 from identical_file_change c where c."assetId" = l."assetId" and c."undoneAt" is null
  ) then 'merged' else 'kept' end`;

/**
 * FL-921: writes a ledger row for assets that were just inserted, in the caller's transaction and in one
 * statement however many there are. A row that is already there is left alone.
 */
export const recordLedgerAdded = async (
  db: Kysely<DB>,
  assetIds: string[],
  addedVia: AssetLedgerAddedVia,
  /** The person who added them; `owner` when that is each asset's own owner (an upload). */
  by: string | 'owner' | null = null,
): Promise<void> => {
  if (assetIds.length === 0) {
    return;
  }
  const stateBy = by === 'owner' ? sql`a."ownerId"` : sql`${by}::uuid`;
  await sql`
    insert into asset_ledger
      ("assetId", "ownerId", checksum, "originalFileName", "addedAt", "addedVia", state, "stateAt", "stateBy")
    select a.id, a."ownerId", a.checksum, a."originalFileName", a."createdAt", ${addedVia}, ${stateOfAsset},
      coalesce(a."deletedAt", a."createdAt"), ${stateBy}
    from asset a
    where a.id = ${anyUuid(assetIds)}
    on conflict ("assetId") do nothing
  `.execute(db);
};

/**
 * FL-921: marks one asset removed in the transaction that deletes its row. A removal somebody asked for
 * was recorded when they asked (with their name), and is left as it is; otherwise an item that sat in the
 * Trash left because its time there ran out.
 */
export const recordLedgerRemoved = async (db: Kysely<DB>, assetId: string, change: Change = {}): Promise<void> => {
  await sql`
    update asset_ledger
    set reason = coalesce(${change.reason ?? null}, case when state = 'trashed' then 'trash-expired' else 'removed' end),
      state = 'removed', "stateAt" = now(), "stateBy" = ${change.by ?? null}::uuid
    where "assetId" = ${assetId}::uuid and state <> 'removed'
  `.execute(db);
};

/** FL-921: a photo now shares another person's identical file; its own copy goes to Unused files. */
export const recordLedgerMerged = async (db: Kysely<DB>, assetId: string, by: string | null): Promise<void> => {
  await sql`
    update asset_ledger set state = 'merged', "stateAt" = now(), "stateBy" = ${by}::uuid, reason = 'identical-file'
    where "assetId" = ${assetId}::uuid and state = 'kept'
  `.execute(db);
};

/** FL-921: the photo has its own file again. */
export const recordLedgerUnmerged = async (db: Kysely<DB>, assetId: string): Promise<void> => {
  await sql`
    update asset_ledger set state = 'kept', "stateAt" = now(), "stateBy" = null, reason = null
    where "assetId" = ${assetId}::uuid and state = 'merged'
  `.execute(db);
};

/**
 * FL-921: everything an account holds, in the transaction that removes its photos. The actor is the
 * administrator who deleted the account, read from the audit trail; null when nobody is recorded.
 */
export const recordLedgerAccountRemoved = async (db: Kysely<DB>, ownerId: string): Promise<void> => {
  await sql`
    update asset_ledger
    set state = 'removed', "stateAt" = now(), reason = 'account-removed',
      "stateBy" = (
        select e."actorId" from admin_audit_event e
        where e."userId" = ${ownerId}::uuid and e.action = 'account-deleted'
        order by e."createdAt" desc limit 1
      )
    where "ownerId" = ${ownerId}::uuid and state <> 'removed'
  `.execute(db);
};

const emptyCounts = (): AssetLedgerCounts => ({ kept: 0, trashed: 0, removed: 0, merged: 0, missing: 0 });

/**
 * FL-921: the nothing-lost ledger (`asset_ledger`). Every write is one statement for however many
 * photos it covers, so bulk paths pay one round trip.
 */
@Injectable()
export class AssetLedgerRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** Photos moved to the Trash. Only rows still among the kept ones move. */
  async trashed(assetIds: string[], by: string | null): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }
    await sql`
      update asset_ledger set state = 'trashed', "stateAt" = now(), "stateBy" = ${by}::uuid, reason = null
      where "assetId" = ${anyUuid(assetIds)} and state in ('kept', 'merged')
    `.execute(this.db);
  }

  /** Photos brought back from the Trash, or from a permanent deletion that was undone before it ran. */
  async restored(assetIds: string[], by: string | null): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }
    await sql`
      update asset_ledger l set state = ${keptState}, "stateAt" = now(), "stateBy" = ${by}::uuid, reason = null
      where l."assetId" = ${anyUuid(assetIds)} and l.state in ('trashed', 'removed')
    `.execute(this.db);
  }

  /** Photos somebody deleted for good; their rows go when the deletion job reaches them. */
  async removed(assetIds: string[], change: Change): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }
    await sql`
      update asset_ledger
      set state = 'removed', "stateAt" = now(), "stateBy" = ${change.by ?? null}::uuid, reason = ${change.reason ?? 'deleted'}
      where "assetId" = ${anyUuid(assetIds)} and state <> 'removed'
    `.execute(this.db);
  }

  /** How many originals are in each state: one account's, or with no owner the whole server's. */
  async counts(ownerId?: string): Promise<AssetLedgerCounts> {
    const { rows } = await sql<{ state: AssetLedgerState; count: string }>`
      select state, count(*) as count from asset_ledger
      ${ownerId ? sql`where "ownerId" = ${ownerId}::uuid` : sql``}
      group by state
    `.execute(this.db);
    const counts = emptyCounts();
    for (const row of rows) {
      if (row.state in counts) {
        counts[row.state] = Number(row.count);
      }
    }
    return counts;
  }

  /** Originals nobody can account for, per account, most first. Read from the small `missing` index. */
  async missingByOwner(): Promise<Array<{ ownerId: string; count: number; since: Date }>> {
    const { rows } = await sql<{ ownerId: string; count: string; since: Date }>`
      select "ownerId", count(*) as count, min("stateAt") as since
      from asset_ledger where state = 'missing'
      group by "ownerId"
      order by count(*) desc, "ownerId"
    `.execute(this.db);
    return rows.map((row) => ({ ...row, count: Number(row.count) }));
  }

  /**
   * One account's rows, the newest change first. With `hideLocked`, photos that are locked now are left
   * out: the reader's session has not unlocked them.
   */
  async list(
    ownerId: string,
    options: { state?: AssetLedgerState; before?: { at: string; assetId: string }; take: number; hideLocked: boolean },
  ): Promise<AssetLedgerRow[]> {
    const { state, before, take, hideLocked } = options;
    const { rows } = await sql<AssetLedgerRow>`
      select l."assetId", l.checksum, l."originalFileName", l."addedAt", l."addedVia", l.state, l."stateAt",
        l."stateBy", l.reason, l."stateAt"::text as "cursorAt"
      from asset_ledger l
      where l."ownerId" = ${ownerId}::uuid
        ${state ? sql`and l.state = ${state}` : sql``}
        ${before ? sql`and (l."stateAt", l."assetId") < (${before.at}::timestamptz, ${before.assetId}::uuid)` : sql``}
        ${hideLocked ? sql`and not exists (select 1 from asset_lock k where k."assetId" = l."assetId")` : sql``}
      order by l."stateAt" desc, l."assetId" desc
      limit ${take}
    `.execute(this.db);
    return rows;
  }

  /**
   * One page of the nightly pass over the ledger, in id order after `after`:
   * - a row whose account is gone is `removed` with its account;
   * - a row whose photo is gone without a recorded removal becomes `missing`;
   * - a row that disagrees with its photo (trashed or restored by a path that told nobody, a deletion
   *   that never ran, a missing photo that is back) takes the photo's state, with no actor.
   * Returns the last id of the page, or null after the last page.
   */
  async reconcilePage(
    after: string | null,
    take: number,
  ): Promise<{ last: string | null; missing: number; corrected: number }> {
    const start = after ?? '00000000-0000-0000-0000-000000000000';
    const edge = await sql<{ assetId: string }>`
      select "assetId" from asset_ledger where "assetId" > ${start}::uuid
      order by "assetId" offset ${take - 1} limit 1
    `.execute(this.db);
    const last = edge.rows[0]?.assetId ?? null;
    const inPage = last
      ? sql`l."assetId" > ${start}::uuid and l."assetId" <= ${last}::uuid`
      : sql`l."assetId" > ${start}::uuid`;

    // an account that is gone took its photos with it: that is a removal, not a loss
    await sql`
      update asset_ledger l
      set state = 'removed', "stateAt" = now(), "stateBy" = null, reason = 'account-removed'
      where ${inPage} and l.state in ('kept', 'trashed', 'merged', 'missing')
        and not exists (select 1 from "user" u where u.id = l."ownerId")
    `.execute(this.db);

    const missing = await sql`
      update asset_ledger l
      set state = 'missing', "stateAt" = now(), "stateBy" = null, reason = 'not-found'
      where ${inPage} and l.state in ('kept', 'trashed', 'merged')
        and not exists (select 1 from asset a where a.id = l."assetId")
    `.execute(this.db);

    const corrected = await sql`
      update asset_ledger l
      set state = case when ${stateOfAsset} = 'kept' then ${keptState} else ${stateOfAsset} end,
        "stateAt" = now(), "stateBy" = null,
        reason = case when l.state = 'missing' then 'found' end
      from asset a
      where a.id = l."assetId" and ${inPage}
        and l.state <> (case when ${stateOfAsset} = 'kept' and l.state = 'merged' then 'merged' else ${stateOfAsset} end)
    `.execute(this.db);

    return {
      last,
      missing: Number(missing.numAffectedRows ?? 0),
      corrected: Number(corrected.numAffectedRows ?? 0),
    };
  }

  /**
   * One page of photos, in id order after `after`, given the ledger row they lack: photos from before
   * the ledger, or added by a path that wrote none. How they arrived is not known, except a library's.
   * Returns the last id of the page, or null after the last page.
   */
  async backfillPage(after: string | null, take: number): Promise<{ last: string | null; added: number }> {
    const start = after ?? '00000000-0000-0000-0000-000000000000';
    const edge = await sql<{ id: string }>`
      select id from asset where id > ${start}::uuid order by id offset ${take - 1} limit 1
    `.execute(this.db);
    const last = edge.rows[0]?.id ?? null;
    const added = await sql`
      insert into asset_ledger
        ("assetId", "ownerId", checksum, "originalFileName", "addedAt", "addedVia", state, "stateAt")
      select a.id, a."ownerId", a.checksum, a."originalFileName", a."createdAt",
        case when a."libraryId" is null then 'unknown' else 'library-scan' end,
        ${stateOfAsset}, coalesce(a."deletedAt", a."createdAt")
      from asset a
      where a.id > ${start}::uuid ${last ? sql`and a.id <= ${last}::uuid` : sql``}
        and not exists (select 1 from asset_ledger l where l."assetId" = a.id)
      on conflict ("assetId") do nothing
    `.execute(this.db);
    return { last, added: Number(added.numAffectedRows ?? 0) };
  }
}
