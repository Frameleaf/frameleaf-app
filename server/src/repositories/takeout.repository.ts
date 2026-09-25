import { Injectable } from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { MediaOperation, MediaOperationCreate } from 'src/repositories/media-operation.repository.js';
import { AlbumUserRole, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { lockPublicForkWrites, withPublicForkWrites } from 'src/repositories/fork-write-guard.js';
import { DB } from 'src/schema/index.js';
import {
  TakeoutFileKind,
  TakeoutItemState,
  TakeoutMetadata,
  TakeoutOptions,
  TakeoutPairState,
  TakeoutPhase,
  TakeoutResultKind,
  TakeoutSidecarCandidate,
  TakeoutSourceKind,
  TakeoutWarning,
} from 'src/utils/takeout.js';

/** FL-44 (FN-304): what every write here answers while a database handoff holds the schema. */
export const TAKEOUT_HANDOFF_REFUSAL = 'Google Photos imports are unavailable during database handoff';

export type TakeoutImport = {
  id: string;
  ownerId: string;
  name: string;
  phase: TakeoutPhase;
  options: Record<string, unknown>;
  runOperationId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type TakeoutSource = {
  id: string;
  importId: string;
  name: string;
  kind: TakeoutSourceKind;
  path: string;
  size: number;
  received: number;
  rejected: number;
  scanned: boolean;
};

export type TakeoutFile = {
  id: string;
  importId: string;
  sourceId: string;
  entryName: string;
  relativePath: string;
  folder: string;
  name: string;
  kind: TakeoutFileKind;
  path: string;
  size: number;
  checksum: Buffer;
  legacyChecksum: Buffer;
  modifiedAt: Date;
  metadata: TakeoutMetadata | null;
};

export type TakeoutItem = {
  id: string;
  importId: string;
  state: TakeoutItemState;
  metadata: TakeoutMetadata;
  sidecarId: string | null;
  candidates: TakeoutSidecarCandidate[];
  albums: string[];
  warnings: TakeoutWarning[];
  locked: boolean;
  assetId: string | null;
  resultKind: TakeoutResultKind | null;
  /** Where a run copied the file before creating its asset (see the column). */
  createPath: string | null;
  /** Goes into Locked, or matched a photo that is Locked: never named to a locked session. */
  withheld: boolean;
  error: string | null;
  /** From the file. */
  relativePath: string;
  folder: string;
  name: string;
  kind: 'image' | 'video';
  path: string;
  size: number;
  checksum: Buffer;
  legacyChecksum: Buffer;
  modifiedAt: Date;
  /** The source's display name. */
  sourceName: string;
};

export type TakeoutPair = {
  photoItemId: string;
  videoItemId: string;
  photoPath: string;
  videoPath: string;
  state: TakeoutPairState;
  error: string | null;
  photoAssetId: string | null;
  videoAssetId: string | null;
};

/** The latest job for an import, as much of it as the wizard shows. */
export type TakeoutOperation = {
  id: string;
  status: MediaOperationStatus;
  snapshot: Record<string, unknown>;
  processedUnits: number;
  totalUnits: number | null;
  error: string | null;
  errorCode: string | null;
};

/** What the library already holds for an asset, for fill-only updates and safety checks. */
export type TakeoutAssetState = {
  id: string;
  ownerId: string;
  deletedAt: Date | null;
  description: string | null;
  latitude: number | null;
  longitude: number | null;
  isFavorite: boolean;
  visibility: string;
  livePhotoVideoId: string | null;
  originalPath: string;
  /** The asset has a lock record. */
  locked: boolean;
};

export type TakeoutCounts = Record<TakeoutItemState, number> & {
  files: number;
  items: number;
  suggestedPairs: number;
  unresolvedPairs: number;
  hiddenLocked: number;
  rejected: number;
};

const json = (value: unknown) => sql`${JSON.stringify(value)}::text::jsonb`;

/**
 * An item that must not be named to a session that has not unlocked Locked: it goes into Locked, or
 * it matched a library photo that is Locked already.
 */
const itemIsLocked = (alias: string) =>
  sql<boolean>`(${sql.ref(`${alias}.locked`)} or exists (
    select 1 from asset_lock where asset_lock."assetId" = ${sql.ref(`${alias}.assetId`)}
  ))`;

/** Media operation statuses that still hold an import. */
const ACTIVE = [
  MediaOperationStatus.Queued,
  MediaOperationStatus.Preparing,
  MediaOperationStatus.Rendering,
  MediaOperationStatus.Validating,
  MediaOperationStatus.Cancelling,
  MediaOperationStatus.Paused,
];

const toNumber = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));

/**
 * The job that describes an import in `phase`: while scanning, and once in review, its latest scan;
 * while importing, and once completed, its latest import. None before the first scan.
 */
export const takeoutOperationFor = (
  phase: TakeoutPhase,
  operations: TakeoutOperation[],
): TakeoutOperation | undefined => {
  const action = phase === 'scanning' || phase === 'review' ? 'scan' : phase === 'sources' ? undefined : 'import';
  return action ? operations.find((operation) => operation.snapshot.action === action) : undefined;
};

const mapImport = (row: Record<string, unknown>): TakeoutImport => ({
  id: row.id as string,
  ownerId: row.ownerId as string,
  name: row.name as string,
  phase: row.phase as TakeoutPhase,
  options: (row.options ?? {}) as Record<string, unknown>,
  runOperationId: (row.runOperationId as string | null) ?? null,
  createdAt: new Date(row.createdAt as string),
  updatedAt: new Date(row.updatedAt as string),
});

const mapSource = (row: Record<string, unknown>): TakeoutSource => ({
  id: row.id as string,
  importId: row.importId as string,
  name: row.name as string,
  kind: row.kind as TakeoutSourceKind,
  path: row.path as string,
  size: toNumber(row.size),
  received: toNumber(row.received),
  rejected: toNumber(row.rejected),
  scanned: row.scanned === true,
});

const mapFile = (row: Record<string, unknown>): TakeoutFile => ({
  id: row.id as string,
  importId: row.importId as string,
  sourceId: row.sourceId as string,
  entryName: row.entryName as string,
  relativePath: row.relativePath as string,
  folder: row.folder as string,
  name: row.name as string,
  kind: row.kind as TakeoutFileKind,
  path: row.path as string,
  size: toNumber(row.size),
  checksum: row.checksum as Buffer,
  legacyChecksum: row.legacyChecksum as Buffer,
  modifiedAt: new Date(row.modifiedAt as string),
  metadata: (row.metadata as TakeoutMetadata | null) ?? null,
});

const mapItem = (row: Record<string, unknown>): TakeoutItem => ({
  id: row.id as string,
  importId: row.importId as string,
  state: row.state as TakeoutItemState,
  metadata: row.metadata as TakeoutMetadata,
  sidecarId: (row.sidecarId as string | null) ?? null,
  candidates: (row.candidates as TakeoutSidecarCandidate[]) ?? [],
  albums: (row.albums as string[]) ?? [],
  warnings: (row.warnings as TakeoutWarning[]) ?? [],
  locked: row.locked === true,
  assetId: (row.assetId as string | null) ?? null,
  resultKind: (row.resultKind as TakeoutResultKind | null) ?? null,
  createPath: (row.createPath as string | null) ?? null,
  withheld: row.withheld === true,
  error: (row.error as string | null) ?? null,
  relativePath: row.relativePath as string,
  folder: row.folder as string,
  name: row.name as string,
  kind: row.kind as 'image' | 'video',
  path: row.path as string,
  size: toNumber(row.size),
  checksum: row.checksum as Buffer,
  legacyChecksum: row.legacyChecksum as Buffer,
  modifiedAt: new Date(row.modifiedAt as string),
  sourceName: row.sourceName as string,
});

/** Thrown when a change is not allowed in the import's current state; the service turns it into a 400. */
export class TakeoutConflict extends Error {}

/** Thrown when an import, source or item is not the owner's or does not exist. */
export class TakeoutNotFound extends Error {}

/**
 * Google Photos imports (FL-65).
 *
 * Every read that answers a request is owner-scoped in the query, so somebody else's import and an
 * import that does not exist give the same answer. Changes that depend on the import's state take the
 * import's row lock first, so a decision and a job starting cannot interleave.
 */
@Injectable()
export class TakeoutRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** FL-44 (FN-304): a write, refused while a database handoff holds the schema. */
  private write<T>(query: (db: Kysely<DB>) => Promise<T>): Promise<T> {
    return withPublicForkWrites(this.db, query, TAKEOUT_HANDOFF_REFUSAL);
  }

  /* ------------------------------------------------------------------ */
  /* Imports                                                             */
  /* ------------------------------------------------------------------ */

  /** A new import, with the server folder it reads from when an administrator chose one. */
  create(
    ownerId: string,
    name: string,
    options: TakeoutOptions,
    directory?: { name: string; path: string },
  ): Promise<TakeoutImport> {
    return this.db.transaction().execute(async (tx) => {
      await lockPublicForkWrites(tx, TAKEOUT_HANDOFF_REFUSAL);
      const { rows } = await sql<Record<string, unknown>>`
        insert into takeout_import ("ownerId", "name", "options")
        values (${ownerId}::uuid, ${name}, ${json(options)})
        returning *
      `.execute(tx);
      const row = mapImport(rows[0]);
      if (directory) {
        await this.addSource(tx, {
          importId: row.id,
          name: directory.name,
          kind: 'directory',
          path: directory.path,
          size: 0,
        });
      }
      return row;
    });
  }

  /**
   * Queue a job for the import inside the caller's transaction, so no worker can see the job before
   * the phase that goes with it has committed.
   */
  async insertOperation(tx: Transaction<DB>, operation: MediaOperationCreate): Promise<MediaOperation> {
    const row = await tx.insertInto('media_operation').values(operation).returningAll().executeTakeFirstOrThrow();
    return row as unknown as MediaOperation;
  }

  async get(ownerId: string, id: string): Promise<TakeoutImport | undefined> {
    const { rows } = await sql<Record<string, unknown>>`
      select * from takeout_import where id = ${id}::uuid and "ownerId" = ${ownerId}::uuid
    `.execute(this.db);
    return rows[0] ? mapImport(rows[0]) : undefined;
  }

  /** For the worker, which already holds the owner's job. */
  async getById(id: string): Promise<TakeoutImport | undefined> {
    const { rows } = await sql<Record<string, unknown>>`select * from takeout_import where id = ${id}::uuid`.execute(
      this.db,
    );
    return rows[0] ? mapImport(rows[0]) : undefined;
  }

  async list(ownerId: string): Promise<TakeoutImport[]> {
    const { rows } = await sql<Record<string, unknown>>`
      select * from takeout_import where "ownerId" = ${ownerId}::uuid order by "createdAt" desc, id desc limit 100
    `.execute(this.db);
    return rows.map((row) => mapImport(row));
  }

  /**
   * Run `fn` holding the import's row lock, with its latest job's status. The callback decides
   * whether the change is allowed in that state; `TakeoutConflict` from it aborts the transaction.
   */
  withImport<T>(
    ownerId: string,
    id: string,
    fn: (tx: Transaction<DB>, row: TakeoutImport, operation: TakeoutOperation | undefined) => Promise<T>,
  ): Promise<T> {
    // FL-44: every change made through `fn` is a write, so the whole transaction takes the guard.
    return this.db.transaction().execute(async (tx) => {
      await lockPublicForkWrites(tx, TAKEOUT_HANDOFF_REFUSAL);
      const { rows } = await sql<Record<string, unknown>>`
        select * from takeout_import where id = ${id}::uuid and "ownerId" = ${ownerId}::uuid for update
      `.execute(tx);
      if (!rows[0]) {
        throw new TakeoutNotFound('Import not found');
      }
      const row = mapImport(rows[0]);
      const operations = await this.latestOperationsIn(tx, ownerId, [id]);
      return fn(
        tx,
        row,
        takeoutOperationFor(
          row.phase,
          operations.map(({ operation }) => operation),
        ),
      );
    });
  }

  async setOptions(tx: Transaction<DB>, id: string, options: TakeoutOptions): Promise<void> {
    await sql`update takeout_import set options = ${json(options)}, "updatedAt" = now() where id = ${id}::uuid`.execute(
      tx,
    );
  }

  async setPhase(tx: Kysely<DB>, id: string, phase: TakeoutPhase): Promise<void> {
    await sql`update takeout_import set phase = ${phase}, "updatedAt" = now() where id = ${id}::uuid`.execute(tx);
  }

  /** The worker finishing a step: move on only from the phase the job was working in. */
  async advancePhase(id: string, from: TakeoutPhase, to: TakeoutPhase): Promise<boolean> {
    const result = await this.write((db) =>
      sql`
      update takeout_import set phase = ${to}, "updatedAt" = now() where id = ${id}::uuid and phase = ${from}
    `.execute(db),
    );
    return Number(result.numAffectedRows ?? 0) === 1;
  }

  async delete(tx: Transaction<DB>, id: string): Promise<void> {
    await sql`delete from takeout_import where id = ${id}::uuid`.execute(tx);
  }

  /**
   * Take the import for a job. Only one job may work on an import at a time: this succeeds when no
   * job holds it, when this job already does, or when the job that held it has finished.
   */
  async claimRun(id: string, operationId: string): Promise<boolean> {
    const result = await this.write((db) =>
      sql`
      update takeout_import set "runOperationId" = ${operationId}::uuid, "updatedAt" = now()
      where id = ${id}::uuid
        and (
          "runOperationId" is null
          or "runOperationId" = ${operationId}::uuid
          or not exists (
            select 1 from media_operation
            where media_operation.id = takeout_import."runOperationId"
              and media_operation.status in (${sql.join(ACTIVE.map((status) => sql.lit(status)))})
          )
        )
    `.execute(db),
    );
    return Number(result.numAffectedRows ?? 0) === 1;
  }

  /**
   * The latest scan job and the latest import job of each import. Which of them describes the import
   * depends on its phase (`takeoutOperationFor`), so an old job retried from Activity never stands in
   * for the step the import is actually on.
   */
  async latestOperations(
    ownerId: string,
    importIds: string[],
  ): Promise<Array<{ importId: string; operation: TakeoutOperation }>> {
    return this.latestOperationsIn(this.db, ownerId, importIds);
  }

  private async latestOperationsIn(
    db: Kysely<DB>,
    ownerId: string,
    importIds: string[],
  ): Promise<Array<{ importId: string; operation: TakeoutOperation }>> {
    if (importIds.length === 0) {
      return [];
    }
    const { rows } = await sql<Record<string, unknown>>`
      select distinct on (snapshot->>'importId', snapshot->>'action')
        snapshot->>'importId' as "importId", id, status, snapshot, "processedUnits", "totalUnits", error, "errorCode"
      from media_operation
      where "ownerId" = ${ownerId}::uuid
        and kind = ${MediaOperationKind.TakeoutImport}
        and snapshot->>'importId' in (${sql.join(importIds)})
      order by snapshot->>'importId', snapshot->>'action', "createdAt" desc, id desc
    `.execute(db);
    return rows.map((row) => ({
      importId: row.importId as string,
      operation: {
        id: row.id as string,
        status: row.status as MediaOperationStatus,
        snapshot: (row.snapshot ?? {}) as Record<string, unknown>,
        processedUnits: toNumber(row.processedUnits),
        totalUnits: row.totalUnits === null || row.totalUnits === undefined ? null : Number(row.totalUnits),
        error: (row.error as string | null) ?? null,
        errorCode: (row.errorCode as string | null) ?? null,
      },
    }));
  }

  /* ------------------------------------------------------------------ */
  /* Sources                                                             */
  /* ------------------------------------------------------------------ */

  async sources(importId: string): Promise<TakeoutSource[]> {
    const { rows } = await sql<Record<string, unknown>>`
      select * from takeout_source where "importId" = ${importId}::uuid order by "createdAt", id
    `.execute(this.db);
    return rows.map((row) => mapSource(row));
  }

  async sourcesIn(tx: Kysely<DB>, importId: string): Promise<TakeoutSource[]> {
    const { rows } = await sql<Record<string, unknown>>`
      select * from takeout_source where "importId" = ${importId}::uuid order by "createdAt", id
    `.execute(tx);
    return rows.map((row) => mapSource(row));
  }

  async addSource(
    tx: Transaction<DB>,
    source: { importId: string; name: string; kind: TakeoutSourceKind; path: string; size: number },
  ): Promise<TakeoutSource> {
    const { rows } = await sql<Record<string, unknown>>`
      insert into takeout_source ("importId", name, kind, path, size)
      values (${source.importId}::uuid, ${source.name}, ${source.kind}, ${source.path}, ${source.size})
      returning *
    `.execute(tx);
    return mapSource(rows[0]);
  }

  async setSourcePath(tx: Transaction<DB>, sourceId: string, path: string): Promise<void> {
    await sql`update takeout_source set path = ${path} where id = ${sourceId}::uuid`.execute(tx);
  }

  /** The staged copies made from one source. */
  async sourceFilePaths(tx: Kysely<DB>, sourceId: string): Promise<string[]> {
    const { rows } = await sql<{ path: string }>`
      select path from takeout_file where "sourceId" = ${sourceId}::uuid
    `.execute(tx);
    return rows.map((row) => row.path);
  }

  /** Bytes of archives the owner has staged in imports that have not finished. */
  async stagedArchiveBytes(tx: Kysely<DB>, ownerId: string): Promise<number> {
    const { rows } = await sql<{ total: string | null }>`
      select coalesce(sum(source.size), 0) as total
      from takeout_source source
      inner join takeout_import import on import.id = source."importId"
      where import."ownerId" = ${ownerId}::uuid and import.phase <> 'completed' and source.kind = 'zip'
    `.execute(tx);
    return toNumber(rows[0]?.total);
  }

  /** Whether any asset's original is the file at `originalPath`. */
  async isOriginalPath(originalPath: string): Promise<boolean> {
    const { rows } = await sql`select 1 from asset where "originalPath" = ${originalPath} limit 1`.execute(this.db);
    return rows.length > 0;
  }

  async removeSource(tx: Transaction<DB>, sourceId: string): Promise<void> {
    await sql`delete from takeout_source where id = ${sourceId}::uuid`.execute(tx);
  }

  /**
   * Write an archive chunk holding the source's row lock, so two uploads of the same archive cannot
   * interleave, and record the new offset in the same transaction.
   */
  async writeChunk(
    ownerId: string,
    importId: string,
    sourceId: string,
    write: (source: TakeoutSource) => Promise<number>,
  ): Promise<TakeoutSource> {
    return this.db.transaction().execute(async (tx) => {
      await lockPublicForkWrites(tx, TAKEOUT_HANDOFF_REFUSAL);
      const { rows: imports } = await sql<{ phase: string }>`
        select phase from takeout_import where id = ${importId}::uuid and "ownerId" = ${ownerId}::uuid for share
      `.execute(tx);
      if (!imports[0]) {
        throw new TakeoutNotFound('Import not found');
      }
      if (imports[0].phase !== 'sources') {
        throw new TakeoutConflict('Archive uploads are closed for this import');
      }
      const { rows } = await sql<Record<string, unknown>>`
        select * from takeout_source
        where id = ${sourceId}::uuid and "importId" = ${importId}::uuid and kind = 'zip'
        for update
      `.execute(tx);
      if (!rows[0]) {
        throw new TakeoutNotFound('Archive not found');
      }
      const source = mapSource(rows[0]);
      const received = await write(source);
      await sql`update takeout_source set received = ${received} where id = ${sourceId}::uuid`.execute(tx);
      return { ...source, received };
    });
  }

  async markSourceScanned(sourceId: string, rejected: number): Promise<void> {
    await sql`update takeout_source set scanned = true, rejected = ${rejected} where id = ${sourceId}::uuid`.execute(
      this.db,
    );
  }

  /* ------------------------------------------------------------------ */
  /* Files                                                               */
  /* ------------------------------------------------------------------ */

  async hasFile(id: string): Promise<boolean> {
    const { rows } = await sql`select 1 from takeout_file where id = ${id}::uuid`.execute(this.db);
    return rows.length > 0;
  }

  async recordFile(file: TakeoutFile): Promise<void> {
    await this.write((db) =>
      sql`
      insert into takeout_file
        (id, "importId", "sourceId", "entryName", "relativePath", folder, name, kind, path, size, checksum, "legacyChecksum", "modifiedAt", metadata)
      values
        (${file.id}::uuid, ${file.importId}::uuid, ${file.sourceId}::uuid, ${file.entryName}, ${file.relativePath},
         ${file.folder}, ${file.name}, ${file.kind}, ${file.path}, ${file.size}, ${file.checksum}, ${file.legacyChecksum},
         ${file.modifiedAt}, ${file.metadata === null ? null : json(file.metadata)})
      on conflict do nothing
    `.execute(db),
    );
  }

  async folders(importId: string): Promise<string[]> {
    const { rows } = await sql<{ folder: string }>`
      select distinct folder from takeout_file where "importId" = ${importId}::uuid order by folder
    `.execute(this.db);
    return rows.map((row) => row.folder);
  }

  async folderFiles(importId: string, folder: string): Promise<TakeoutFile[]> {
    const { rows } = await sql<Record<string, unknown>>`
      select * from takeout_file where "importId" = ${importId}::uuid and folder = ${folder} order by id
    `.execute(this.db);
    return rows.map((row) => mapFile(row));
  }

  /** Staged sidecars are only needed until the scan has matched them; media until it is imported. */
  async stagedSidecarPaths(importId: string): Promise<string[]> {
    const { rows } = await sql<{ path: string }>`
      select path from takeout_file where "importId" = ${importId}::uuid and kind = 'sidecar'
    `.execute(this.db);
    return rows.map((row) => row.path);
  }

  /* ------------------------------------------------------------------ */
  /* Items                                                               */
  /* ------------------------------------------------------------------ */

  async recordItem(item: {
    id: string;
    importId: string;
    state: TakeoutItemState;
    metadata: TakeoutMetadata;
    sidecarId: string | null;
    candidates: TakeoutSidecarCandidate[];
    albums: string[];
    warnings: TakeoutWarning[];
    locked: boolean;
  }): Promise<void> {
    // A resumed scan meets items it already recorded, and the owner may have decided about them
    // since. Only an item still waiting, without a chosen sidecar, is updated, and only when this scan
    // found more candidates for it: a sidecar that arrived in an archive added after the first scan.
    await this.write((db) =>
      sql`
      insert into takeout_item (id, "importId", state, metadata, "sidecarId", candidates, albums, warnings, locked)
      values (${item.id}::uuid, ${item.importId}::uuid, ${item.state}, ${json(item.metadata)}, ${item.sidecarId}::uuid,
              ${json(item.candidates)}, ${json(item.albums)}, ${json(item.warnings)}, ${item.locked})
      on conflict (id) do update set
        state = excluded.state,
        metadata = excluded.metadata,
        "sidecarId" = excluded."sidecarId",
        candidates = excluded.candidates,
        warnings = excluded.warnings,
        locked = takeout_item.locked or excluded.locked,
        "updatedAt" = now()
      where takeout_item.state in ('ready', 'review')
        and takeout_item."sidecarId" is null
        and jsonb_array_length(takeout_item.candidates) < jsonb_array_length(excluded.candidates)
    `.execute(db),
    );
  }

  private itemSelect(db: Kysely<DB>, where: ReturnType<typeof sql>, tail: ReturnType<typeof sql> = sql``) {
    return sql<Record<string, unknown>>`
      select item.*, file."relativePath", file.folder, file.name, file.kind, file.path, file.size, file.checksum,
             file."legacyChecksum", file."modifiedAt", source.name as "sourceName",
             ${itemIsLocked('item')} as withheld
      from takeout_item item
      inner join takeout_file file on file.id = item.id
      inner join takeout_source source on source.id = file."sourceId"
      where ${where}
      ${tail}
    `.execute(db);
  }

  /** A page of items. `includeLocked` is false for a session that has not unlocked Locked. */
  async items(
    importId: string,
    query: { state?: TakeoutItemState; offset: number; limit: number; includeLocked: boolean },
  ): Promise<{ items: TakeoutItem[]; total: number }> {
    const where = sql`item."importId" = ${importId}::uuid
      ${query.state ? sql`and item.state = ${query.state}` : sql``}
      ${query.includeLocked ? sql`` : sql`and not ${itemIsLocked('item')}`}`;
    const [{ rows }, count] = await Promise.all([
      this.itemSelect(
        this.db,
        where,
        sql`order by file."relativePath", item.id limit ${query.limit} offset ${query.offset}`,
      ),
      sql<{ total: string }>`select count(*) as total from takeout_item item where ${where}`.execute(this.db),
    ]);
    return { items: rows.map((row) => mapItem(row)), total: toNumber(count.rows[0]?.total) };
  }

  async getItem(importId: string, itemId: string): Promise<TakeoutItem | undefined> {
    const { rows } = await this.itemSelect(
      this.db,
      sql`item."importId" = ${importId}::uuid and item.id = ${itemId}::uuid`,
    );
    return rows[0] ? mapItem(rows[0]) : undefined;
  }

  async lockItem(tx: Transaction<DB>, importId: string, itemId: string): Promise<TakeoutItem | undefined> {
    const { rows } = await this.itemSelect(
      tx,
      sql`item."importId" = ${importId}::uuid and item.id = ${itemId}::uuid`,
      sql`for update of item`,
    );
    return rows[0] ? mapItem(rows[0]) : undefined;
  }

  async updateDecision(
    tx: Transaction<DB>,
    itemId: string,
    decision: { state: TakeoutItemState; sidecarId: string | null; metadata: TakeoutMetadata },
  ): Promise<void> {
    await sql`
      update takeout_item
      set state = ${decision.state}, "sidecarId" = ${decision.sidecarId}::uuid, metadata = ${json(decision.metadata)},
          error = null, "updatedAt" = now()
      where id = ${itemId}::uuid
    `.execute(tx);
  }

  /** The next items a run imports, in a stable order. Items it already finished are never returned. */
  async pendingItems(importId: string, limit: number): Promise<TakeoutItem[]> {
    const { rows } = await this.itemSelect(
      this.db,
      sql`item."importId" = ${importId}::uuid and item.state in ('ready', 'importing')`,
      sql`order by item.id limit ${limit}`,
    );
    return rows.map((row) => mapItem(row));
  }

  async countPending(importId: string): Promise<number> {
    const { rows } = await sql<{ total: string }>`
      select count(*) as total from takeout_item where "importId" = ${importId}::uuid and state in ('ready', 'importing')
    `.execute(this.db);
    return toNumber(rows[0]?.total);
  }

  /** Items that failed get their one automatic retry: back to ready, error kept until they run. */
  async retryFailed(importId: string): Promise<number> {
    const result = await this.write((db) =>
      sql`
      update takeout_item set state = 'ready', "updatedAt" = now()
      where "importId" = ${importId}::uuid and state = 'failed'
    `.execute(db),
    );
    return Number(result.numAffectedRows ?? 0);
  }

  /** With sidecar review switched off, disputed items import with only their own metadata. */
  async releaseReview(tx: Kysely<DB>, importId: string): Promise<void> {
    await sql`
      update takeout_item set state = 'ready', "sidecarId" = null,
        metadata = jsonb_build_object('title', (select file.name from takeout_file file where file.id = takeout_item.id)),
        "updatedAt" = now()
      where "importId" = ${importId}::uuid and state = 'review'
    `.execute(tx);
  }

  /** Items waiting for a decision, and how many of them a locked session cannot see. */
  async countReview(tx: Kysely<DB>, importId: string): Promise<{ total: number; locked: number }> {
    const { rows } = await sql<{ total: string; locked: string }>`
      select count(*) as total, count(*) filter (where ${itemIsLocked('takeout_item')}) as locked
      from takeout_item where "importId" = ${importId}::uuid and state = 'review'
    `.execute(tx);
    return { total: toNumber(rows[0]?.total), locked: toNumber(rows[0]?.locked) };
  }

  /**
   * Record, before the upload, that this run is creating the asset. A run that stops after the upload
   * and before `itemAsset` finds the checksum in the library on its next attempt, and this tells it
   * the asset is its own creation rather than a photo that was already there.
   */
  async itemCreating(itemId: string, createPath: string): Promise<void> {
    await this.write((db) =>
      sql`
      update takeout_item set state = 'importing', "createPath" = ${createPath}, "updatedAt" = now()
      where id = ${itemId}::uuid
    `.execute(db),
    );
  }

  async itemAsset(itemId: string, assetId: string, resultKind: TakeoutResultKind): Promise<void> {
    await this.write((db) =>
      sql`
      update takeout_item set state = 'importing', "assetId" = ${assetId}::uuid, "resultKind" = ${resultKind},
        "updatedAt" = now()
      where id = ${itemId}::uuid
    `.execute(db),
    );
  }

  async itemDone(itemId: string, state: TakeoutItemState, error: string | null = null): Promise<void> {
    await this.write((db) =>
      sql`
      update takeout_item set state = ${state}, error = ${error}, "updatedAt" = now() where id = ${itemId}::uuid
    `.execute(db),
    );
  }

  async counts(importId: string): Promise<TakeoutCounts> {
    const [states, files, pairs, rejected] = await Promise.all([
      sql<{ state: TakeoutItemState; total: string; locked: string }>`
        select state, count(*) as total, count(*) filter (where ${itemIsLocked('takeout_item')}) as locked
        from takeout_item where "importId" = ${importId}::uuid group by state
      `.execute(this.db),
      sql<{ total: string }>`select count(*) as total from takeout_file where "importId" = ${importId}::uuid`.execute(
        this.db,
      ),
      sql<{ state: TakeoutPairState; total: string }>`
        select state, count(*) as total from takeout_pair where "importId" = ${importId}::uuid group by state
      `.execute(this.db),
      sql<{ total: string }>`
        select coalesce(sum(rejected), 0) as total from takeout_source where "importId" = ${importId}::uuid
      `.execute(this.db),
    ]);

    const counts: TakeoutCounts = {
      ready: 0,
      review: 0,
      importing: 0,
      imported: 0,
      matched: 0,
      skipped: 0,
      failed: 0,
      files: toNumber(files.rows[0]?.total),
      items: 0,
      suggestedPairs: 0,
      unresolvedPairs: 0,
      hiddenLocked: 0,
      rejected: toNumber(rejected.rows[0]?.total),
    };
    for (const row of states.rows) {
      counts[row.state] = toNumber(row.total);
      counts.items += toNumber(row.total);
      counts.hiddenLocked += toNumber(row.locked);
    }
    for (const row of pairs.rows) {
      if (row.state === 'suggested') {
        counts.suggestedPairs += toNumber(row.total);
      } else if (row.state === 'failed') {
        counts.unresolvedPairs += toNumber(row.total);
      }
    }
    return counts;
  }

  /**
   * Of the items still to import, how many are already in the owner's library (matched by either
   * digest, trash included) and how many are new. One index probe per item, so only asked for when
   * the wizard shows it, never while a job is running.
   */
  async matchSummary(ownerId: string, importId: string): Promise<{ newAssets: number; matchedOriginals: number }> {
    const { rows } = await sql<{ matched: string; fresh: string }>`
      select
        count(*) filter (where found) as matched,
        count(*) filter (where not found) as fresh
      from (
        select exists (
          select 1 from asset
          where asset."ownerId" = ${ownerId}::uuid
            and asset.checksum in (file.checksum, file."legacyChecksum")
        ) as found
        from takeout_item item
        inner join takeout_file file on file.id = item.id
        where item."importId" = ${importId}::uuid and item.state in ('ready', 'review', 'importing', 'failed')
      ) as pending
    `.execute(this.db);
    return { matchedOriginals: toNumber(rows[0]?.matched), newAssets: toNumber(rows[0]?.fresh) };
  }

  /**
   * The export's folders with their item counts. For a session that has not unlocked Locked, Locked
   * items are not counted, and a folder holding only Locked items is not listed.
   */
  async albums(importId: string, includeLocked: boolean): Promise<Array<{ folder: string; count: number }>> {
    const { rows } = await sql<{ folder: string; count: string }>`
      select file.folder, count(*) as count
      from takeout_item item inner join takeout_file file on file.id = item.id
      where item."importId" = ${importId}::uuid and file.folder <> ''
        ${includeLocked ? sql`` : sql`and not ${itemIsLocked('item')}`}
      group by file.folder order by file.folder
    `.execute(this.db);
    return rows.map((row) => ({ folder: row.folder, count: toNumber(row.count) }));
  }

  /* ------------------------------------------------------------------ */
  /* Live Photo pairs                                                    */
  /* ------------------------------------------------------------------ */

  async recordPair(importId: string, photoItemId: string, videoItemId: string): Promise<void> {
    await this.write((db) =>
      sql`
      insert into takeout_pair ("importId", "photoItemId", "videoItemId", reason)
      values (${importId}::uuid, ${photoItemId}::uuid, ${videoItemId}::uuid, 'same_name')
      on conflict do nothing
    `.execute(db),
    );
  }

  async pairs(
    importId: string,
    query: { state?: TakeoutPairState; offset: number; limit: number; includeLocked: boolean },
  ): Promise<{ pairs: TakeoutPair[]; total: number }> {
    const where = sql`pair."importId" = ${importId}::uuid
      ${query.state ? sql`and pair.state = ${query.state}` : sql``}
      ${query.includeLocked ? sql`` : sql`and not ${itemIsLocked('photo_item')} and not ${itemIsLocked('video_item')}`}`;
    const from = sql`
      from takeout_pair pair
      inner join takeout_item photo_item on photo_item.id = pair."photoItemId"
      inner join takeout_item video_item on video_item.id = pair."videoItemId"
      inner join takeout_file photo on photo.id = pair."photoItemId"
      inner join takeout_file video on video.id = pair."videoItemId"`;
    const [{ rows }, count] = await Promise.all([
      sql<TakeoutPair>`
        select pair."photoItemId", pair."videoItemId", pair.state, pair.error,
               photo."relativePath" as "photoPath", video."relativePath" as "videoPath",
               photo_item."assetId" as "photoAssetId", video_item."assetId" as "videoAssetId"
        ${from}
        where ${where}
        order by photo."relativePath", pair.id
        limit ${query.limit} offset ${query.offset}
      `.execute(this.db),
      sql<{ total: string }>`select count(*) as total ${from} where ${where}`.execute(this.db),
    ]);
    return { pairs: rows, total: toNumber(count.rows[0]?.total) };
  }

  /** A decision about one pair. Approving refuses a second pair that shares either part. */
  async decidePair(tx: Transaction<DB>, importId: string, photoItemId: string, videoItemId: string, approve: boolean) {
    if (approve) {
      const { rows } = await sql`
        select 1 from takeout_pair
        where "importId" = ${importId}::uuid and state in ('approved', 'linked')
          and ("photoItemId" = ${photoItemId}::uuid or "videoItemId" = ${videoItemId}::uuid)
          and not ("photoItemId" = ${photoItemId}::uuid and "videoItemId" = ${videoItemId}::uuid)
      `.execute(tx);
      if (rows.length > 0) {
        throw new TakeoutConflict('One of these files is already paired with another');
      }
    }
    const result = await sql`
      update takeout_pair set state = ${approve ? 'approved' : 'skipped'}, error = null
      where "importId" = ${importId}::uuid and "photoItemId" = ${photoItemId}::uuid
        and "videoItemId" = ${videoItemId}::uuid and state <> 'linked'
    `.execute(tx);
    if (Number(result.numAffectedRows ?? 0) !== 1) {
      throw new TakeoutConflict('This pair was not found or is already linked');
    }
  }

  async approvedPairs(importId: string, limit: number): Promise<TakeoutPair[]> {
    const { rows } = await sql<TakeoutPair>`
      select pair."photoItemId", pair."videoItemId", pair.state, pair.error,
             photo."relativePath" as "photoPath", video."relativePath" as "videoPath",
             photo_item."assetId" as "photoAssetId", video_item."assetId" as "videoAssetId"
      from takeout_pair pair
      inner join takeout_item photo_item on photo_item.id = pair."photoItemId"
      inner join takeout_item video_item on video_item.id = pair."videoItemId"
      inner join takeout_file photo on photo.id = pair."photoItemId"
      inner join takeout_file video on video.id = pair."videoItemId"
      where pair."importId" = ${importId}::uuid and pair.state = 'approved'
      order by pair.id
      limit ${limit}
    `.execute(this.db);
    return rows;
  }

  async countApprovedPairs(importId: string): Promise<number> {
    const { rows } = await sql<{ total: string }>`
      select count(*) as total from takeout_pair where "importId" = ${importId}::uuid and state = 'approved'
    `.execute(this.db);
    return toNumber(rows[0]?.total);
  }

  async pairDone(photoItemId: string, videoItemId: string, error: string | null): Promise<void> {
    await this.write((db) =>
      sql`
      update takeout_pair set state = ${error ? 'failed' : 'linked'}, error = ${error}
      where "photoItemId" = ${photoItemId}::uuid and "videoItemId" = ${videoItemId}::uuid
    `.execute(db),
    );
  }

  /** Failed pairs get their automatic retry with the items. */
  async retryFailedPairs(importId: string): Promise<number> {
    const result = await this.write((db) =>
      sql`
      update takeout_pair set state = 'approved' where "importId" = ${importId}::uuid and state = 'failed'
    `.execute(db),
    );
    return Number(result.numAffectedRows ?? 0);
  }

  /* ------------------------------------------------------------------ */
  /* Albums and assets                                                   */
  /* ------------------------------------------------------------------ */

  /** The album an export folder became for this owner, while it exists and they still own it. */
  async getAlbumFor(ownerId: string, folder: string): Promise<string | undefined> {
    const { rows } = await sql<{ albumId: string }>`
      select mapping."albumId"
      from takeout_album mapping
      inner join album on album.id = mapping."albumId" and album."deletedAt" is null
      inner join album_user owner on owner."albumId" = album.id and owner."userId" = ${ownerId}::uuid
        and owner.role = ${AlbumUserRole.Owner}
      where mapping."ownerId" = ${ownerId}::uuid and mapping.folder = ${folder}
    `.execute(this.db);
    return rows[0]?.albumId;
  }

  /**
   * Record the album a folder became, unless another run recorded a usable one first: the album that
   * is recorded is returned, and the caller removes its own when it lost. A mapping whose album was
   * deleted, or is no longer the owner's, is replaced.
   */
  async setAlbumFor(ownerId: string, folder: string, albumId: string): Promise<string> {
    return this.db.transaction().execute(async (tx) => {
      await lockPublicForkWrites(tx, TAKEOUT_HANDOFF_REFUSAL);
      await sql`
        delete from takeout_album mapping
        where mapping."ownerId" = ${ownerId}::uuid and mapping.folder = ${folder}
          and not exists (
            select 1 from album
            inner join album_user owner on owner."albumId" = album.id and owner."userId" = ${ownerId}::uuid
              and owner.role = ${AlbumUserRole.Owner}
            where album.id = mapping."albumId" and album."deletedAt" is null
          )
      `.execute(tx);
      const { rows } = await sql<{ albumId: string }>`
        insert into takeout_album ("ownerId", folder, "albumId") values (${ownerId}::uuid, ${folder}, ${albumId}::uuid)
        on conflict ("ownerId", folder) do nothing
        returning "albumId"
      `.execute(tx);
      if (rows[0]) {
        return rows[0].albumId;
      }
      const { rows: existing } = await sql<{ albumId: string }>`
        select "albumId" from takeout_album where "ownerId" = ${ownerId}::uuid and folder = ${folder}
      `.execute(tx);
      return existing[0]?.albumId ?? albumId;
    });
  }

  async getAssetState(assetId: string): Promise<TakeoutAssetState | undefined> {
    const { rows } = await sql<Record<string, unknown>>`
      select asset.id, asset."ownerId", asset."deletedAt", asset."isFavorite", asset.visibility, asset."livePhotoVideoId",
             asset."originalPath", asset_exif.description, asset_exif.latitude, asset_exif.longitude,
             exists (select 1 from asset_lock where asset_lock."assetId" = asset.id) as locked
      from asset left join asset_exif on asset_exif."assetId" = asset.id
      where asset.id = ${assetId}::uuid
    `.execute(this.db);
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return {
      id: row.id as string,
      ownerId: row.ownerId as string,
      deletedAt: row.deletedAt ? new Date(row.deletedAt as string) : null,
      description: (row.description as string | null) ?? null,
      latitude: row.latitude === null || row.latitude === undefined ? null : Number(row.latitude),
      longitude: row.longitude === null || row.longitude === undefined ? null : Number(row.longitude),
      isFavorite: row.isFavorite === true,
      visibility: row.visibility as string,
      livePhotoVideoId: (row.livePhotoVideoId as string | null) ?? null,
      originalPath: row.originalPath as string,
      locked: row.locked === true,
    };
  }
}
