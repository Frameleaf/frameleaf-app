import { ConflictException, Injectable } from '@nestjs/common';
import { Kysely, Transaction } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { CaptureSourceDto } from 'src/dtos/bookmark.dto.js';
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
}
