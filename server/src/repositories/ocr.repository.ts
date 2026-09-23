import { Injectable } from '@nestjs/common';
import { type Insertable, type Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AssetOcrResponseDto } from 'src/dtos/ocr.dto.js';
import { DB } from 'src/schema/index.js';
import { AssetOcrTable } from 'src/schema/tables/asset-ocr.table.js';
import { tokenizeForSearch } from 'src/utils/database.js';

@Injectable()
export class OcrRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID] })
  getById(id: string) {
    return this.db.selectFrom('asset_ocr').selectAll('asset_ocr').where('asset_ocr.id', '=', id).executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getByAssetId(id: string, options?: { isVisible?: boolean }) {
    const isVisible = options === undefined ? true : options.isVisible;

    return this.db
      .selectFrom('asset_ocr')
      .selectAll('asset_ocr')
      .where('asset_ocr.assetId', '=', id)
      .$if(isVisible !== undefined, (qb) => qb.where('asset_ocr.isVisible', '=', isVisible!))
      .execute();
  }

  deleteAll() {
    return this.db.transaction().execute(async (trx: Kysely<DB>) => {
      await sql`truncate ${sql.table('asset_ocr')}`.execute(trx);
      await sql`truncate ${sql.table('ocr_search')}`.execute(trx);
    });
  }

  @GenerateSql({
    params: [
      DummyValue.UUID,
      [
        {
          assetId: DummyValue.UUID,
          x1: DummyValue.NUMBER,
          y1: DummyValue.NUMBER,
          x2: DummyValue.NUMBER,
          y2: DummyValue.NUMBER,
          x3: DummyValue.NUMBER,
          y3: DummyValue.NUMBER,
          x4: DummyValue.NUMBER,
          y4: DummyValue.NUMBER,
          text: DummyValue.STRING,
          boxScore: DummyValue.NUMBER,
          textScore: DummyValue.NUMBER,
        },
      ],
      DummyValue.STRING,
    ],
  })
  upsert(assetId: string, ocrDataList: Insertable<AssetOcrTable>[], searchText: string) {
    let query = this.db.with('deleted_ocr', (db) => db.deleteFrom('asset_ocr').where('assetId', '=', assetId));
    // eslint-disable-next-line unicorn/prefer-ternary
    if (ocrDataList.length > 0) {
      (query as any) = query
        .with('inserted_ocr', (db) => db.insertInto('asset_ocr').values(ocrDataList))
        .with('inserted_search', (db) =>
          db
            .insertInto('ocr_search')
            .values({ assetId, text: searchText })
            .onConflict((oc) => oc.column('assetId').doUpdateSet((eb) => ({ text: eb.ref('excluded.text') }))),
        );
    } else {
      (query as any) = query.with('deleted_search', (db) => db.deleteFrom('ocr_search').where('assetId', '=', assetId));
    }

    return query.selectNoFrom(sql`1`.as('dummy')).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, [], []] })
  async updateOcrVisibilities(
    assetId: string,
    visible: AssetOcrResponseDto[],
    hidden: AssetOcrResponseDto[],
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      if (visible.length > 0) {
        await trx
          .updateTable('asset_ocr')
          .set({ isVisible: true })
          .where(
            'asset_ocr.id',
            'in',
            visible.map((i) => i.id),
          )
          .execute();
      }

      if (hidden.length > 0) {
        await trx
          .updateTable('asset_ocr')
          .set({ isVisible: false })
          .where(
            'asset_ocr.id',
            'in',
            hidden.map((i) => i.id),
          )
          .execute();
      }

      // FL-63: the searchable text is rebuilt from every line that is visible now, tokenized the way
      // `upsert` writes it. Built from `visible` alone it lost the lines this edit did not touch (an
      // edit without a crop passes only the lines it restored), so a rotated photo stopped being
      // found by its text, and a later crop could still be found by text it no longer shows.
      const lines = await trx
        .selectFrom('asset_ocr')
        .select('asset_ocr.text')
        .where('asset_ocr.assetId', '=', assetId)
        .where('asset_ocr.isVisible', '=', true)
        .execute();
      const searchText = lines.flatMap((line) => tokenizeForSearch(line.text)).join(' ');
      await trx.updateTable('ocr_search').set({ text: searchText }).where('assetId', '=', assetId).execute();
    });
  }
}
