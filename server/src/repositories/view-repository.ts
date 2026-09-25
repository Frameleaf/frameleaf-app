import { type Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { DB } from 'src/schema/index.js';
import { asUuid, withExif, withHiddenContentFilter } from 'src/utils/database.js';
import { isTimelineVisible } from 'src/utils/locked.js';

/** The folder an original sits in: its path up to (not including) the last slash. */
const DIRECTORY_PATTERN = '^(.*/)[^/]*$';

export type FolderSummaryRow = { path: string; count: number; size: number };

export class ViewRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /**
   * The owner's Timeline assets a folder view may list: nothing Locked, archived, trashed or (FL-46)
   * hidden from the session, so a folder never names an item its viewer could not open.
   */
  private folderAssets(userId: string, options?: HiddenContentQueryOptions) {
    return this.db
      .selectFrom('asset')
      .where('asset.ownerId', '=', asUuid(userId))
      .where(isTimelineVisible('asset'))
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
      .where(isTimelineVisible('asset'))
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

    return this.db
      .selectFrom('asset')
      .selectAll('asset')
      .$call(withExif)
      .where('ownerId', '=', asUuid(userId))
      .where(isTimelineVisible('asset'))
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
      .execute();
  }

  /**
   * FL-46: per folder, how many of the owner's listable originals sit directly in it and their bytes
   * (from the extracted file size), in the same scope as the two queries above. The Folders browser
   * adds these up the tree for a folder's total and size, so no folder needs its files fetched.
   */
  async getFolderSummary(userId: string, options?: HiddenContentQueryOptions): Promise<FolderSummaryRow[]> {
    const rows = await this.folderAssets(userId, options)
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select((eb) => [
        eb.fn<string>('substring', ['asset.originalPath', eb.val(DIRECTORY_PATTERN)]).as('directoryPath'),
        eb.fn.countAll<string>().as('count'),
        sql<string>`coalesce(sum("asset_exif"."fileSizeInByte"), 0)`.as('size'),
      ])
      .groupBy((eb) => eb.fn('substring', ['asset.originalPath', eb.val(DIRECTORY_PATTERN)]))
      .orderBy('directoryPath', 'asc')
      .execute();

    return rows.map((row) => ({
      path: row.directoryPath.replaceAll(/\/$/g, ''),
      count: Number(row.count),
      size: Number(row.size),
    }));
  }
}
