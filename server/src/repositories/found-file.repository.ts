import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type {
  FoundFileOutcome as SortedOutcome,
  FoundFileReason as SortedReason,
  FoundFileStep,
  FoundFileTable,
} from 'src/schema/tables/found-file.table.js';
import { AssetFileType } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { asUuid } from 'src/utils/database.js';

/**
 * FL-1537: `outcome` and `reason` are text columns, and these are the values the review adds to them.
 * They are declared here, not on the table: the table's file is part of the captured schema, and no
 * column changed. `left`: a person undid what was done, or chose to leave the file; it is not sorted
 * again while it stays the same file. `tidied`: a file Frameleaf makes itself, cleared (`preview`) or
 * joined to its photo (`sidecar`). `asked`: putting found photos back is switched off, so it waits.
 */
export type FoundFileOutcome = SortedOutcome | 'left' | 'tidied';
export type FoundFileReason = SortedReason | 'asked' | 'preview' | 'sidecar';

export type FoundFile = Omit<Selectable<FoundFileTable>, 'outcome'> & { outcome: FoundFileOutcome };
export type FoundFileWrite = Omit<Insertable<FoundFileTable>, 'outcome'> & { outcome: FoundFileOutcome };
/** A found file with the account it belongs to: its folder's, else its photo's. */
export type FoundFileListed = FoundFile & { effectiveOwnerId: string | null };

export type FoundFileFilter = {
  outcome: FoundFileOutcome;
  reason?: FoundFileReason;
  /** The account folder the files are in. */
  folder?: string;
  ownerId?: string;
  /** The id of the last file of the page before. */
  cursor?: string;
  size: number;
};

/**
 * The account folder a found file is in: everything up to the folder under `upload` or `library`.
 * ponytail: read from the path each time; store it in a column if the review ever gets slow.
 */
const accountFolder = sql<string | null>`substring(found_file."path" from '^(.*/(?:upload|library)/[^/]+)/')`;

/** FL-1532: what Frameleaf remembers about each file it found on the drive that no library lists. */
@Injectable()
export class FoundFileRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** The files among `paths` that were read before. */
  getByPaths(paths: string[]): Promise<FoundFile[]> {
    if (paths.length === 0) {
      return Promise.resolve([]);
    }
    return this.db
      .selectFrom('found_file')
      .selectAll()
      .where(sql<boolean>`"path" = any(${paths}::text[])`)
      .execute() as Promise<FoundFile[]>;
  }

  /** What was learned about the file at this path replaces what was known about it. */
  async upsert(file: FoundFileWrite): Promise<void> {
    // A JSON array has to be sent as JSON text: the driver would send a JavaScript array as a Postgres
    // array, and JSON cast straight to jsonb would be stored as one JSON string (see jsonb-cast.spec.ts).
    const row = {
      ...(file as Insertable<FoundFileTable>),
      steps: sql<FoundFileStep[]>`${JSON.stringify(file.steps ?? [])}::text::jsonb`,
    };
    const { path: _path, ...changes } = row;
    await this.db
      .insertInto('found_file')
      .values(row)
      .onConflict((oc) => oc.column('path').doUpdateSet({ ...changes, sortedAt: sql`now()` }))
      .execute();
  }

  private listed() {
    return this.db
      .selectFrom('found_file')
      .leftJoin('asset', 'asset.id', 'found_file.assetId')
      .selectAll('found_file')
      .select((eb) => eb.fn.coalesce('found_file.ownerId', 'asset.ownerId').as('effectiveOwnerId'));
  }

  /** FL-1537: one found file. */
  get(id: string): Promise<FoundFileListed | undefined> {
    return this.listed().where('found_file.id', '=', asUuid(id)).executeTakeFirst() as Promise<
      FoundFileListed | undefined
    >;
  }

  /** FL-1537: a page of the found files with one outcome, oldest first. */
  list({ outcome, reason, folder, ownerId, cursor, size }: FoundFileFilter): Promise<FoundFileListed[]> {
    return this.listed()
      .where('found_file.outcome', '=', outcome as SortedOutcome)
      .$if(!!reason, (qb) => qb.where('found_file.reason', '=', reason!))
      .$if(!!ownerId, (qb) => qb.where('found_file.ownerId', '=', asUuid(ownerId!)))
      .$if(!!folder, (qb) => qb.where(sql<boolean>`starts_with(found_file."path", ${folder + '/'})`))
      .$if(!!cursor, (qb) => qb.where('found_file.id', '>', asUuid(cursor!)))
      .orderBy('found_file.id')
      .limit(size)
      .execute() as Promise<FoundFileListed[]>;
  }

  /** FL-1537: how many files, and how many bytes, each outcome and reason holds. */
  async counts(): Promise<{ outcome: string; reason: string | null; count: number; sizeInBytes: number }[]> {
    const rows = await this.db
      .selectFrom('found_file')
      .select(['outcome', 'reason'])
      .select((eb) => [
        eb.fn.countAll<string>().as('count'),
        eb.fn.coalesce(eb.fn.sum<string>('sizeInBytes'), sql.lit('0')).as('sizeInBytes'),
      ])
      .groupBy(['outcome', 'reason'])
      .execute();
    return rows.map((row) => ({ ...row, count: Number(row.count), sizeInBytes: Number(row.sizeInBytes) }));
  }

  /**
   * FL-1537: the files waiting for a person, as the groups one decision covers: the files in one folder
   * no account uses, or the files of one account for one reason.
   */
  async needsGroups(): Promise<
    { reason: string | null; ownerId: string | null; folder: string | null; count: number; sizeInBytes: number }[]
  > {
    const folder = sql<string | null>`CASE WHEN found_file."ownerId" IS NULL THEN ${accountFolder} END`;
    const rows = await this.db
      .selectFrom('found_file')
      .select(['reason', 'ownerId'])
      .select(folder.as('folder'))
      .select((eb) => [
        eb.fn.countAll<string>().as('count'),
        eb.fn.coalesce(eb.fn.sum<string>('sizeInBytes'), sql.lit('0')).as('sizeInBytes'),
      ])
      .where('outcome', '=', 'needs')
      .groupBy(['reason', 'ownerId', folder])
      .orderBy(sql`count(*)`, 'desc')
      .limit(200)
      .execute();
    return rows.map((row) => ({ ...row, count: Number(row.count), sizeInBytes: Number(row.sizeInBytes) }));
  }

  /** FL-1537: the file is forgotten: it was deleted, at a person's word. */
  async delete(id: string): Promise<void> {
    await this.db.deleteFrom('found_file').where('id', '=', asUuid(id)).execute();
  }

  /** FL-1537: which of these photos are still in a library (in the Trash counts). */
  async existingAssetIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) {
      return new Set();
    }
    const rows = await this.db
      .selectFrom('asset')
      .select('id')
      .where(sql<boolean>`"id" = any(${ids}::uuid[])`)
      .execute();
    return new Set(rows.map(({ id }) => id));
  }

  /** FL-1537: the photos kept at these paths that have no XMP file of their own yet. */
  assetsWithoutSidecar(originalPaths: string[]): Promise<{ id: string; originalPath: string }[]> {
    if (originalPaths.length === 0) {
      return Promise.resolve([]);
    }
    return this.db
      .selectFrom('asset')
      .select(['asset.id', 'asset.originalPath'])
      .where('asset.originalPath', 'in', originalPaths)
      .where('asset.deletedAt', 'is', null)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('asset_file')
              .select('asset_file.id')
              .whereRef('asset_file.assetId', '=', 'asset.id')
              .where('asset_file.type', '=', AssetFileType.Sidecar),
          ),
        ),
      )
      .execute();
  }

  /**
   * FL-1579: the photos whose file is one of `stems` plus a photo or video ending (`…/photo` for
   * `…/photo.jpg`), each with the stem it matched and whether it has an XMP file of its own. For an XMP
   * named `photo.xmp`, which says nothing of its photo's ending.
   *
   * ponytail: every stem is tried with every ending as an exact path, because the only index on
   * `asset."originalPath"` is a plain btree, which a search by the start of a path cannot use under the
   * database's collation. That is stems × endings index lookups per call (about 100,000 for 500 stems),
   * so callers send a few hundred stems at a time; and an ending written in mixed case (`.Jpg`) is not
   * found. A `text_pattern_ops` index on the path would lift both, at the price of a schema change.
   */
  async assetsNamed(
    stems: string[],
    endings: string[],
  ): Promise<{ id: string; originalPath: string; stem: string; hasSidecar: boolean }[]> {
    if (stems.length === 0 || endings.length === 0) {
      return [];
    }
    const { rows } = await sql<{ id: string; originalPath: string; stem: string; hasSidecar: boolean }>`
      SELECT a.id, a."originalPath", s.stem,
        EXISTS (
          SELECT 1 FROM asset_file f WHERE f."assetId" = a.id AND f.type = ${AssetFileType.Sidecar}
        ) AS "hasSidecar"
      FROM unnest(${stems}::text[]) AS s(stem)
      CROSS JOIN unnest(${endings}::text[]) AS e(ending)
      JOIN asset a ON a."originalPath" = s.stem || e.ending
      WHERE a."deletedAt" IS NULL`.execute(this.db);
    return rows;
  }
}
