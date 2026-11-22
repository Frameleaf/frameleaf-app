import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { RemoteCursor, RemoteItem } from 'src/import-connectors/remote-source.js';
import type { MediaOperationCreate } from 'src/repositories/media-operation.repository.js';
import type { TakeoutItemState, TakeoutOptions } from 'src/utils/takeout.js';
import { MediaOperationKind } from 'src/enum.js';
import { TAKEOUT_ACTIVE_STATUSES } from 'src/repositories/takeout.repository.js';
import { DB } from 'src/schema/index.js';

export type ImportConnection = {
  id: string;
  ownerId: string;
  provider: string;
  displayName: string;
  sealedCredentials: Buffer;
  roots: string[];
  dailyCheck: boolean;
  cursor: RemoteCursor | null;
  lastScanAt: Date | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

/** A file the connection saw at its source, with what its run made of it so far. */
export type ImportConnectionItem = {
  id: string;
  remoteId: string;
  path: string;
  size: number;
  modifiedAt: Date;
  albumHint: string | null;
  caption: string | null;
  favourite: boolean;
  /** What the scan saw, so a resumed download can tell the file has not changed since. */
  contentHash?: string | null;
  /** `ready` until it is downloaded, then whatever the import made of it. */
  state: TakeoutItemState;
  assetId: string | null;
  error: string | null;
};

export const IMPORT_CONNECTION_ACTIVE = 'active';
export const IMPORT_CONNECTION_SIGN_IN_REQUIRED = 'sign_in_required';

const json = (value: unknown) => sql`${JSON.stringify(value)}::text::jsonb`;
const toNumber = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));

const mapConnection = (row: Record<string, unknown>): ImportConnection => ({
  id: row.id as string,
  ownerId: row.ownerId as string,
  provider: row.provider as string,
  displayName: row.displayName as string,
  sealedCredentials: row.sealedCredentials as Buffer,
  roots: (row.roots as string[]) ?? [],
  dailyCheck: row.dailyCheck === true,
  cursor: (row.cursor as RemoteCursor | null) ?? null,
  lastScanAt: row.lastScanAt ? new Date(row.lastScanAt as string) : null,
  status: row.status as string,
  createdAt: new Date(row.createdAt as string),
  updatedAt: new Date(row.updatedAt as string),
});

const mapItem = (row: Record<string, unknown>): ImportConnectionItem => ({
  id: row.id as string,
  remoteId: row.remoteId as string,
  path: row.path as string,
  size: toNumber(row.size),
  modifiedAt: new Date(row.modifiedAt as string),
  albumHint: (row.albumHint as string | null) ?? null,
  caption: (row.caption as string | null) ?? null,
  favourite: row.favourite === true,
  contentHash: (row.contentHash as string | null) ?? null,
  state: row.state as TakeoutItemState,
  assetId: (row.assetId as string | null) ?? null,
  error: (row.error as string | null) ?? null,
});

/** A job is queued for, or working on, one of the connection's runs. */
const busy = (connectionId: string) => sql<boolean>`exists (
  select 1 from takeout_import run
  inner join media_operation operation
    on operation."ownerId" = run."ownerId"
    and operation.kind = ${MediaOperationKind.TakeoutImport}
    and operation.snapshot->>'importId' = run.id::text
  where run."connectionId" = ${connectionId}::uuid
    and operation.status in (${sql.join(TAKEOUT_ACTIVE_STATUSES.map((status) => sql.lit(status)))})
)`;

/** What a run's file is now: waiting for its download, or whatever the import made of it. */
const itemState = sql`coalesce(item.state, case when seen.error is null then 'ready' else 'failed' end)`;
const itemFrom = sql`from import_connection_item seen left join takeout_item item on item.id = seen."fileId"`;
/** Matched a photo that is Locked: never named to a session that has not unlocked Locked. */
const itemWithheld = sql<boolean>`exists (select 1 from asset_lock where asset_lock."assetId" = item."assetId")`;

/**
 * Import connections (FL-920): the connections themselves and the files each has seen at its source.
 * A run of a connection is a `takeout_import` row and is read and changed through `TakeoutRepository`.
 *
 * Every read that answers a request is owner-scoped in the query. Nothing here removes a file's row
 * because the file is gone from the source.
 */
@Injectable()
export class ImportConnectorRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  async create(connection: {
    id: string;
    ownerId: string;
    provider: string;
    displayName: string;
    sealedCredentials: Buffer;
    roots: string[];
    dailyCheck: boolean;
  }): Promise<ImportConnection> {
    const { rows } = await sql<Record<string, unknown>>`
      insert into import_connection (id, "ownerId", provider, "displayName", "sealedCredentials", roots, "dailyCheck")
      values (${connection.id}::uuid, ${connection.ownerId}::uuid, ${connection.provider}, ${connection.displayName},
              ${connection.sealedCredentials}, ${json(connection.roots)}, ${connection.dailyCheck})
      returning *
    `.execute(this.db);
    return mapConnection(rows[0]);
  }

  async list(ownerId: string): Promise<ImportConnection[]> {
    const { rows } = await sql<Record<string, unknown>>`
      select * from import_connection where "ownerId" = ${ownerId}::uuid order by "createdAt", id
    `.execute(this.db);
    return rows.map((row) => mapConnection(row));
  }

  async get(ownerId: string, id: string): Promise<ImportConnection | undefined> {
    const { rows } = await sql<Record<string, unknown>>`
      select * from import_connection where id = ${id}::uuid and "ownerId" = ${ownerId}::uuid
    `.execute(this.db);
    return rows[0] ? mapConnection(rows[0]) : undefined;
  }

  /** For the worker, which already holds the owner's job. */
  async getById(id: string): Promise<ImportConnection | undefined> {
    const { rows } = await sql<Record<string, unknown>>`
      select * from import_connection where id = ${id}::uuid
    `.execute(this.db);
    return rows[0] ? mapConnection(rows[0]) : undefined;
  }

  /** Photos each connection has brought in or found already in the library. */
  async importedCounts(connectionIds: string[]): Promise<Map<string, number>> {
    if (connectionIds.length === 0) {
      return new Map();
    }
    const { rows } = await sql<{ connectionId: string; total: string }>`
      select seen."connectionId", count(*) as total
      from import_connection_item seen inner join takeout_item item on item.id = seen."fileId"
      where seen."connectionId" = any(${`{${connectionIds}}`}::uuid[]) and item.state in ('imported', 'matched')
      group by seen."connectionId"
    `.execute(this.db);
    return new Map(rows.map((row) => [row.connectionId, toNumber(row.total)]));
  }

  /**
   * Change what the owner may change. New credentials make the connection usable again; new roots
   * forget the cursor, because it stood for the old ones.
   */
  async update(
    id: string,
    changes: { displayName?: string; dailyCheck?: boolean; sealedCredentials?: Buffer; roots?: string[] },
  ): Promise<void> {
    await this.db
      .updateTable('import_connection')
      .set({
        ...(changes.displayName !== undefined && { displayName: changes.displayName }),
        ...(changes.dailyCheck !== undefined && { dailyCheck: changes.dailyCheck }),
        ...(changes.sealedCredentials && {
          sealedCredentials: changes.sealedCredentials,
          status: IMPORT_CONNECTION_ACTIVE,
        }),
        ...(changes.roots && { roots: sql<string[]>`${json(changes.roots)}`, cursor: null }),
        updatedAt: sql<Date>`now()`,
      })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Change a connection's sealed credentials with its row locked, so two workers renewing a rotating
   * refresh token take turns. `change` gets the current value and returns the new one, or null to keep
   * it. The status is left alone: a renewal is not the owner signing in again. False when the row is gone.
   */
  async withSealedCredentials(id: string, change: (sealed: Buffer) => Promise<Buffer | null>): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      const { rows } = await sql<{ sealedCredentials: Buffer }>`
        select "sealedCredentials" from import_connection where id = ${id}::uuid for update
      `.execute(tx);
      if (!rows[0]) {
        return false;
      }
      const next = await change(rows[0].sealedCredentials);
      if (next) {
        await sql`
          update import_connection set "sealedCredentials" = ${next}, "updatedAt" = now() where id = ${id}::uuid
        `.execute(tx);
      }
      return true;
    });
  }

  async setStatus(id: string, status: string): Promise<void> {
    await sql`update import_connection set status = ${status}, "updatedAt" = now() where id = ${id}::uuid`.execute(
      this.db,
    );
  }

  /** Remove a connection and its runs, unless a job is at work on one. The photos it brought in stay. */
  async delete(ownerId: string, id: string): Promise<'deleted' | 'busy' | 'missing'> {
    return this.db.transaction().execute(async (tx) => {
      const { rows } = await sql<{ busy: boolean }>`
        select ${busy(id)} as busy from import_connection
        where id = ${id}::uuid and "ownerId" = ${ownerId}::uuid for update
      `.execute(tx);
      if (!rows[0]) {
        return 'missing';
      }
      if (rows[0].busy) {
        return 'busy';
      }
      await sql`delete from import_connection where id = ${id}::uuid`.execute(tx);
      return 'deleted';
    });
  }

  /** How many connections there are, by kind. All an administrator is told about other accounts' connections. */
  async statistics(): Promise<Array<{ provider: string; connections: number; dailyCheck: number }>> {
    const { rows } = await sql<{ provider: string; connections: string; dailyCheck: string }>`
      select provider, count(*) as connections, count(*) filter (where "dailyCheck") as "dailyCheck"
      from import_connection group by provider order by provider
    `.execute(this.db);
    return rows.map((row) => ({
      provider: row.provider,
      connections: toNumber(row.connections),
      dailyCheck: toNumber(row.dailyCheck),
    }));
  }

  /* ------------------------------------------------------------------ */
  /* Runs                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Start a scan: a new run in `scanning` with its one source and the job that scans it, all in one
   * transaction holding the connection's row, so two scans of a connection never start together.
   * With `dueBefore` (the daily check) nothing starts unless the connection still wants a daily check,
   * is usable, and its last scan started before then.
   */
  async startScan(
    connectionId: string,
    options: TakeoutOptions,
    operation: (connection: ImportConnection, importId: string) => MediaOperationCreate,
    dueBefore?: Date,
  ): Promise<'busy' | 'missing' | 'not_due' | { importId: string }> {
    return this.db.transaction().execute(async (tx) => {
      const { rows } = await sql<Record<string, unknown>>`
        select *, ${busy(connectionId)} as busy from import_connection where id = ${connectionId}::uuid for update
      `.execute(tx);
      if (!rows[0]) {
        return 'missing';
      }
      const connection = mapConnection(rows[0]);
      if (
        dueBefore &&
        (!connection.dailyCheck ||
          connection.status !== IMPORT_CONNECTION_ACTIVE ||
          (connection.lastScanAt && connection.lastScanAt > dueBefore))
      ) {
        return 'not_due';
      }
      if (rows[0].busy === true) {
        return 'busy';
      }
      const { rows: runs } = await sql<{ id: string }>`
        insert into takeout_import ("ownerId", name, options, phase, "connectionId")
        values (${connection.ownerId}::uuid, ${connection.displayName}, ${json(options)}, 'scanning',
                ${connection.id}::uuid)
        returning id
      `.execute(tx);
      const importId = runs[0].id;
      await sql`
        insert into takeout_source ("importId", name, kind, path, size)
        values (${importId}::uuid, ${connection.displayName}, 'directory', '', 0)
      `.execute(tx);
      await tx.insertInto('media_operation').values(operation(connection, importId)).execute();
      await sql`
        update import_connection set "lastScanAt" = now(), "updatedAt" = now() where id = ${connection.id}::uuid
      `.execute(tx);
      return { importId };
    });
  }

  /** Connections whose daily check is due: wanted, usable, and not scanned since `before`. */
  async dueForDailyCheck(before: Date): Promise<string[]> {
    const { rows } = await sql<{ id: string }>`
      select id from import_connection
      where "dailyCheck" and status = ${IMPORT_CONNECTION_ACTIVE}
        and ("lastScanAt" is null or "lastScanAt" <= ${before})
      order by "lastScanAt" nulls first, id
      limit 100
    `.execute(this.db);
    return rows.map(({ id }) => id);
  }

  /** A scan that found nothing leaves no run behind. Only ever removes a run with no files. */
  async deleteEmptyRun(importId: string): Promise<void> {
    await sql`
      delete from takeout_import where id = ${importId}::uuid and "connectionId" is not null
        and not exists (select 1 from import_connection_item where "importId" = ${importId}::uuid)
    `.execute(this.db);
  }

  async setCursor(connectionId: string, cursor: RemoteCursor | null): Promise<void> {
    await sql`
      update import_connection set cursor = ${cursor === null ? null : json(cursor)}, "updatedAt" = now()
      where id = ${connectionId}::uuid
    `.execute(this.db);
  }

  /* ------------------------------------------------------------------ */
  /* Files seen at the source                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Offer a file to a run. True when the run takes it: the connection has not seen the file before,
   * the file changed at the source since it did, or the run that offered it earlier is gone. A file
   * the connection already holds unchanged is left exactly as it is.
   */
  async offer(connectionId: string, importId: string, item: RemoteItem): Promise<boolean> {
    const { rows } = await sql`
      insert into import_connection_item
        ("connectionId", "remoteId", path, size, "modifiedAt", "contentHash", "albumHint", caption, favourite, "importId")
      values (${connectionId}::uuid, ${item.remoteId}, ${item.path}, ${item.size}, ${item.modifiedAt},
              ${item.contentHash ?? null}, ${item.albumHint}, ${item.caption ?? null}, ${item.favourite === true},
              ${importId}::uuid)
      on conflict ("connectionId", "remoteId") do update set
        path = excluded.path, size = excluded.size, "modifiedAt" = excluded."modifiedAt",
        "contentHash" = excluded."contentHash", "albumHint" = excluded."albumHint", caption = excluded.caption,
        favourite = excluded.favourite, "importId" = excluded."importId", "fileId" = null, error = null
      where import_connection_item.size <> excluded.size
        or import_connection_item."modifiedAt" <> excluded."modifiedAt"
        or import_connection_item."contentHash" is distinct from excluded."contentHash"
        or (import_connection_item."importId" is null and import_connection_item."fileId" is null)
      returning id
    `.execute(this.db);
    return rows.length > 0;
  }

  /** The next files of a run to download, in a stable order. */
  async pendingItems(importId: string, limit: number): Promise<ImportConnectionItem[]> {
    const { rows } = await sql<Record<string, unknown>>`
      select seen.*, 'ready' as state, null as "assetId"
      from import_connection_item seen
      where seen."importId" = ${importId}::uuid and seen."fileId" is null and seen.error is null
      order by seen.id limit ${limit}
    `.execute(this.db);
    return rows.map((row) => mapItem(row));
  }

  async pendingCount(importId: string): Promise<number> {
    const { rows } = await sql<{ total: string }>`
      select count(*) as total from import_connection_item
      where "importId" = ${importId}::uuid and "fileId" is null and error is null
    `.execute(this.db);
    return toNumber(rows[0]?.total);
  }

  async itemStaged(id: string, fileId: string): Promise<void> {
    await sql`
      update import_connection_item set "fileId" = ${fileId}::uuid, error = null where id = ${id}::uuid
    `.execute(this.db);
  }

  async itemFailed(id: string, error: string): Promise<void> {
    await sql`update import_connection_item set error = ${error} where id = ${id}::uuid`.execute(this.db);
  }

  /** Downloads that failed are tried again by the next pass. */
  async retryFailed(importId: string, db: Kysely<DB> = this.db): Promise<number> {
    const result = await sql`
      update import_connection_item set error = null
      where "importId" = ${importId}::uuid and "fileId" is null and error is not null
    `.execute(db);
    return Number(result.numAffectedRows ?? 0);
  }

  /** A page of a run's files for review. `includeLocked` is false for a session that has not unlocked Locked. */
  async items(
    importId: string,
    query: { state?: TakeoutItemState; offset: number; limit: number; includeLocked: boolean },
  ): Promise<{ items: ImportConnectionItem[]; total: number; hiddenLocked: number }> {
    const where = sql`seen."importId" = ${importId}::uuid
      ${query.state ? sql`and ${itemState} = ${query.state}` : sql``}`;
    const visible = query.includeLocked ? sql`` : sql`and not ${itemWithheld}`;
    const [{ rows }, count] = await Promise.all([
      sql<Record<string, unknown>>`
        select seen.*, ${itemState} as state, item."assetId", coalesce(item.error, seen.error) as error
        ${itemFrom}
        where ${where} ${visible}
        order by seen.path, seen.id limit ${query.limit} offset ${query.offset}
      `.execute(this.db),
      sql<{ total: string; hidden: string }>`
        select count(*) filter (where true ${visible}) as total,
               count(*) filter (where ${itemWithheld}) as hidden
        ${itemFrom} where ${where}
      `.execute(this.db),
    ]);
    return {
      items: rows.map((row) => mapItem(row)),
      total: toNumber(count.rows[0]?.total),
      hiddenLocked: query.includeLocked ? 0 : toNumber(count.rows[0]?.hidden),
    };
  }

  /** A run's files by state, and how many matched a Locked photo. */
  async counts(importId: string): Promise<{ states: Partial<Record<TakeoutItemState, number>>; hiddenLocked: number }> {
    const { rows } = await sql<{ state: TakeoutItemState; total: string; hidden: string }>`
      select ${itemState} as state, count(*) as total, count(*) filter (where ${itemWithheld}) as hidden
      ${itemFrom} where seen."importId" = ${importId}::uuid group by 1
    `.execute(this.db);
    const states: Partial<Record<TakeoutItemState, number>> = {};
    let hiddenLocked = 0;
    for (const row of rows) {
      states[row.state] = toNumber(row.total);
      hiddenLocked += toNumber(row.hidden);
    }
    return { states, hiddenLocked };
  }

  /** The albums a run's files ask for, with how many files each. */
  async albums(importId: string): Promise<Array<{ folder: string; count: number }>> {
    const { rows } = await sql<{ folder: string; count: string }>`
      select "albumHint" as folder, count(*) as count from import_connection_item
      where "importId" = ${importId}::uuid and "albumHint" is not null and "albumHint" <> ''
      group by "albumHint" order by "albumHint"
    `.execute(this.db);
    return rows.map((row) => ({ folder: row.folder, count: toNumber(row.count) }));
  }
}
