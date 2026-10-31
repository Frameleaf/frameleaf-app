import { ConflictException, Injectable } from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import type { AssetSourceImportedFrom } from 'src/schema/tables/asset-source.table.js';
import { CaptureSourceDto } from 'src/dtos/bookmark.dto.js';
import { LibraryScope } from 'src/enum.js';
import { DB } from 'src/schema/index.js';

@Injectable()
export class AssetSourceRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  async upsertCapture(tx: Transaction<DB>, input: CaptureSourceDto & { assetId: string }) {
    await tx
      .insertInto('asset_source')
      .values(input)
      .onConflict((oc) => oc.column('captureId').doNothing())
      .execute();
    // A second statement sees the concurrent winner under READ COMMITTED.
    const source = await tx
      .selectFrom('asset_source')
      .selectAll()
      .where('captureId', '=', input.captureId)
      .where('assetId', '=', input.assetId)
      .executeTakeFirst();
    if (!source) throw new ConflictException('Capture ID already used');
    return source;
  }

  getAll(assetId: string) {
    return this.db
      .selectFrom('asset_source')
      .selectAll()
      .where('assetId', '=', assetId)
      .orderBy('createdAt')
      .orderBy('id')
      .execute();
  }

  /**
   * FL-653: records an imported web address on an asset, once. An address the asset already has
   * (saved by the extension, or by an earlier run of the same import) is returned as it is, so an
   * import that is carried on never adds a second copy. The lock makes two items with the same file
   * in one import add it once.
   */
  addImported(input: { assetId: string; importedFrom: AssetSourceImportedFrom; pageUrl: string; title: string }) {
    return this.db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`asset_source:${input.assetId}`}, 0))`.execute(tx);
      const existing = await tx
        .selectFrom('asset_source')
        .selectAll()
        .where('assetId', '=', input.assetId)
        .where('pageUrl', '=', input.pageUrl)
        .orderBy('createdAt')
        .orderBy('id')
        .executeTakeFirst();
      if (existing) {
        return existing;
      }
      return tx
        .insertInto('asset_source')
        .values({ ...input, captureId: randomUUID(), capturedAt: new Date(), mediaUrl: null })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  /**
   * FL-653: moves the Added date of the owner's Boards-only item earlier, to `addedAt`. Nothing
   * changes, and false is returned, unless the asset is the owner's, is in Boards only, is not in
   * the trash, and was added after `addedAt`. The update trigger moves `updateId`, so apps that sync
   * see the new date.
   */
  async moveAddedDateEarlier(input: { assetId: string; ownerId: string; addedAt: Date }) {
    const row = await this.db
      .updateTable('asset')
      .set({ createdAt: input.addedAt })
      .where('id', '=', input.assetId)
      .where('ownerId', '=', input.ownerId)
      .where('libraryScope', '=', LibraryScope.Design)
      .where('deletedAt', 'is', null)
      .where('createdAt', '>=', input.addedAt)
      .returning('id')
      .executeTakeFirst();
    return !!row;
  }
}
