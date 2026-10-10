import { type Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { DB } from 'src/schema/index.js';
import { asUuid, withExif, withHiddenContentFilter } from 'src/utils/database.js';
import { isLocked, isTimelineVisible } from 'src/utils/locked.js';

/** The folder an original sits in: its path up to (not including) the last slash. */
const DIRECTORY_PATTERN = '^(.*/)[^/]*$';

/** How many items a folder's cover shows. */
const COVER_ASSETS = 4;

export type FolderSummaryRow = {
  path: string;
  count: number;
  size: number;
  coverAssetIds: string[];
  startDate: Date;
  endDate: Date;
};

export class ViewRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /**
   * The owner's Timeline assets a folder view may list: nothing Locked (except, FL-195, the owner's own
   * revealed locks in an unlocked session), archived, trashed or (FL-46) hidden from the session, so a
   * folder never names an item its viewer could not open.
   */
  private folderAssets(userId: string, options?: HiddenContentQueryOptions) {
    return this.db
      .selectFrom('asset')
      .where('asset.ownerId', '=', asUuid(userId))
      .where(isTimelineVisible('asset', options?.revealLockedOwnerId))
      .where('asset.deletedAt', 'is', null)
      .where('asset.fileCreatedAt', 'is not', null)
      .where('asset.fileModifiedAt', 'is not', null)
      .where('asset.localDateTime', 'is not', null)
      .$call((qb) => withHiddenContentFilter(qb, options));
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getUniqueOriginalPaths(userId: string, options?: HiddenContentQueryOptions) {
    const results = await this.db
      .selectFrom('asset')
      .select((eb) => eb.fn<string>('substring', ['asset.originalPath', eb.val(DIRECTORY_PATTERN)]).as('directoryPath'))
      .distinct()
      .where('ownerId', '=', asUuid(userId))
      .where(isTimelineVisible('asset', options?.revealLockedOwnerId))
      .where('deletedAt', 'is', null)
      .where('fileCreatedAt', 'is not', null)
      .where('fileModifiedAt', 'is not', null)
      .where('localDateTime', 'is not', null)
      .$call((qb) => withHiddenContentFilter(qb, options))
      .orderBy('directoryPath', 'asc')
      .execute();

    return results.map((row) => row.directoryPath.replaceAll(/\/$/g, ''));
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  async getAssetsByOriginalPath(userId: string, partialPath: string, options?: HiddenContentQueryOptions) {
    const normalizedPath = partialPath.replaceAll(/\/$/g, '');

    return (
      this.db
        .selectFrom('asset')
        .selectAll('asset')
        // FL-195: a revealed lock reads as `locked` (`effectiveVisibilityOf`) so the web marks it
        .select(isLocked('asset').as('isLocked'))
        .$call(withExif)
        .where('ownerId', '=', asUuid(userId))
        .where(isTimelineVisible('asset', options?.revealLockedOwnerId))
        .where('deletedAt', 'is', null)
        .where('fileCreatedAt', 'is not', null)
        .where('fileModifiedAt', 'is not', null)
        .where('localDateTime', 'is not', null)
        .where('originalPath', 'like', `%${normalizedPath}/%`)
        .where('originalPath', 'not like', `%${normalizedPath}/%/%`)
        .$call((qb) => withHiddenContentFilter(qb, options))
        .orderBy(
          (eb) => eb.fn('regexp_replace', ['asset.originalPath', eb.val('.*/(.+)'), eb.val(String.raw`\1`)]),
          'asc',
        )
        .execute()
    );
  }

  /**
   * FL-46: per folder, how many of the owner's listable originals sit directly in it and their bytes
   * (from the extracted file size), in the same scope as the two queries above. The Folders browser
   * adds these up the tree for a folder's total and size, so no folder needs its files fetched.
   *
   * Each folder also gets what its card shows of those originals: the newest few by capture time for a
   * cover, and the first and last capture day, read as an album's start and end dates are.
   */
  async getFolderSummary(userId: string, options?: HiddenContentQueryOptions): Promise<FolderSummaryRow[]> {
    // the pattern is a literal, not a bound parameter: Postgres works the folder out once per file only
    // when the partitioned expression is the selected one exactly, and two parameters with the same
    // value are two different expressions to it
    const directoryPath = sql<string>`substring("asset"."originalPath", ${sql.lit(DIRECTORY_PATTERN)})`;
    const files = this.folderAssets(userId, options)
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select([
        'asset.id',
        'asset.localDateTime',
        'asset_exif.fileSizeInByte',
        directoryPath.as('directoryPath'),
        sql<number>`row_number() over (partition by ${directoryPath} order by "asset"."localDateTime" desc, "asset"."id" asc)`.as(
          'rank',
        ),
      ]);
    const rows = await this.db
      .selectFrom(files.as('file'))
      .select((eb) => [
        'file.directoryPath',
        eb.fn.countAll<string>().as('count'),
        sql<string>`coalesce(sum("file"."fileSizeInByte"), 0)`.as('size'),
        sql<
          string[] | null
        >`array_agg("file"."id"::text order by "file"."rank") filter (where "file"."rank" <= ${sql.lit(COVER_ASSETS)})`.as(
          'coverAssetIds',
        ),
        eb.fn.min(sql<Date>`("file"."localDateTime" AT TIME ZONE 'UTC'::text)::date`).as('startDate'),
        eb.fn.max(sql<Date>`("file"."localDateTime" AT TIME ZONE 'UTC'::text)::date`).as('endDate'),
      ])
      .groupBy('file.directoryPath')
      .orderBy('file.directoryPath', 'asc')
      .execute();

    return rows.map((row) => ({
      path: row.directoryPath.replaceAll(/\/$/g, ''),
      count: Number(row.count),
      size: Number(row.size),
      coverAssetIds: row.coverAssetIds ?? [],
      startDate: row.startDate,
      endDate: row.endDate,
    }));
  }
}
