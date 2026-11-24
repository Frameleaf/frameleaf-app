import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AssetFileType, AssetVisibility } from 'src/enum.js';
import { publicationDatabase } from 'src/queue/transaction.js';
import { DB } from 'src/schema/index.js';
import { asUuid, hiddenByOwnerRules } from 'src/utils/database.js';
import { isLocked } from 'src/utils/locked.js';

const candidateColumns = [
  'asset.id',
  'asset.ownerId',
  'asset.type',
  'asset.status',
  'asset.visibility',
  'asset.deletedAt',
  'asset.isOffline',
  'asset.libraryId',
  'asset.stackId',
  'asset.livePhotoVideoId',
] as const;

export type PrintBackCandidate = {
  id: string;
  ownerId: string;
  type: string;
  status: string;
  visibility: AssetVisibility;
  deletedAt: Date | null;
  isOffline: boolean;
  libraryId: string | null;
  stackId: string | null;
  livePhotoVideoId: string | null;
  isLocked: boolean;
  isRuleHidden: boolean;
  isCopy: boolean;
  isPaired: boolean;
};

@Injectable()
export class PrintBackRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {
    this.db = publicationDatabase(this.db);
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getByFront(frontAssetId: string) {
    return this.db
      .selectFrom('asset_print_back')
      .innerJoin('asset as front', 'front.id', 'asset_print_back.frontAssetId')
      .select(['asset_print_back.frontAssetId', 'asset_print_back.backAssetId', 'front.ownerId'])
      .where('asset_print_back.frontAssetId', '=', asUuid(frontAssetId))
      .executeTakeFirst();
  }

  /**
   * Pairs in one transaction, with both rows locked in id order so two pairings sharing a photo run one after the
   * other and `validate` sees the truth. The back leaves everything that shows it to someone else (albums, links,
   * item shares, memories, a duplicate group). Those are not put back on unpair: sharing it again is the owner's call.
   * Its text leaves `ocr_search`, so no search returns it; `OcrRepository.setPrintBackSearchText` files it under the front.
   */
  pair(
    frontAssetId: string,
    backAssetId: string,
    validate: (front?: PrintBackCandidate, back?: PrintBackCandidate) => void,
  ) {
    return this.db.transaction().execute(async (tx) => {
      const rows = (await tx
        .selectFrom('asset')
        .select(candidateColumns)
        .select((eb) => [
          isLocked('asset').as('isLocked'),
          hiddenByOwnerRules('asset').as('isRuleHidden'),
          sql<boolean>`exists (select 1 from public.asset_origin origin where origin."assetId" = asset.id)`.as(
            'isCopy',
          ),
          eb
            .exists(
              eb
                .selectFrom('asset_print_back as pair')
                .select(sql`1`.as('found'))
                .where((pair) =>
                  pair.or([
                    pair('pair.frontAssetId', '=', pair.ref('asset.id')),
                    pair('pair.backAssetId', '=', pair.ref('asset.id')),
                  ]),
                ),
            )
            .as('isPaired'),
        ])
        .where('asset.id', 'in', [asUuid(frontAssetId), asUuid(backAssetId)])
        .orderBy('asset.id')
        .forUpdate('asset')
        .execute()) as unknown as PrintBackCandidate[];
      const front = rows.find(({ id }) => id === frontAssetId);
      const back = rows.find(({ id }) => id === backAssetId);
      validate(front, back);

      await tx
        .insertInto('asset_print_back')
        .values({ frontAssetId, backAssetId, backPreviousVisibility: back!.visibility })
        .execute();
      await tx
        .updateTable('asset')
        .set({ visibility: AssetVisibility.Hidden, duplicateId: null })
        .where('id', '=', asUuid(backAssetId))
        .execute();
      await tx
        .updateTable('album')
        .set({ albumThumbnailAssetId: null })
        .where('albumThumbnailAssetId', '=', asUuid(backAssetId))
        .execute();
      await tx.deleteFrom('album_asset').where('assetId', '=', asUuid(backAssetId)).execute();
      await tx.deleteFrom('shared_link_asset').where('assetId', '=', asUuid(backAssetId)).execute();
      await tx.deleteFrom('memory_asset').where('assetId', '=', asUuid(backAssetId)).execute();
      await sql`DELETE FROM public.asset_user_share WHERE "assetId" = ${asUuid(backAssetId)}`.execute(tx);
      await tx.updateTable('ocr_search').set({ text: '' }).where('assetId', '=', asUuid(backAssetId)).execute();

      const status = await tx
        .selectFrom('asset_job_status')
        .select('ocrAt')
        .where('assetId', '=', asUuid(backAssetId))
        .executeTakeFirst();
      const preview = await tx
        .selectFrom('asset_file')
        .select('id')
        .where('assetId', '=', asUuid(backAssetId))
        .where('type', '=', AssetFileType.Preview)
        .executeTakeFirst();
      return { ownerId: back!.ownerId, wasRead: !!status?.ocrAt, hasPreview: !!preview };
    });
  }

  /**
   * Removes the pair; the `asset_print_back_released` trigger restores the back's visibility. A Locked back keeps
   * its own lock row. Answers the back and what it returned to, or nothing if there was no pair.
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  unpair(frontAssetId: string) {
    return this.db
      .deleteFrom('asset_print_back')
      .where('frontAssetId', '=', asUuid(frontAssetId))
      .returning(['backAssetId', 'backPreviousVisibility'])
      .executeTakeFirst();
  }
}
