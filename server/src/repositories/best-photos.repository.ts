import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AssetStatus, AssetType, AssetVisibility } from 'src/enum.js';
import { deferJobAdoption } from 'src/queue/context.js';
import { DB } from 'src/schema/index.js';
import { AssetBestPhotoScoreTable } from 'src/schema/tables/asset-best-photo-score.table.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { anyUuid, asUuid, withHiddenContentFilter } from 'src/utils/database.js';
import { isLocked, revealedLockScope } from 'src/utils/locked.js';
import { paginationHelper } from 'src/utils/pagination.js';

export type BestPhotoScore = Selectable<AssetBestPhotoScoreTable>;
export type BestPhotoScoreUpsert = Omit<Insertable<AssetBestPhotoScoreTable>, 'createdAt' | 'updatedAt'>;

type BestPhotoAssetRow = Selectable<AssetTable> & {
  /** FL-195: a revealed lock reads as `locked` in the response (`effectiveVisibilityOf`) */
  isLocked: boolean;
  bestPhotoScore: number;
  bestPhotoAestheticScore: number | null;
  bestPhotoTechnicalScore: number | null;
  bestPhotoSubjectScore: number | null;
  bestPhotoDiversityScore: number | null;
  bestPhotoScoreVersion: number;
  bestPhotoComputedAt: Date;
  bestPhotoMetadata: Record<string, unknown> | null;
  bestPhotoBestFrameTimestampMs: number | null;
  bestPhotoFrameScore: number | null;
  bestPhotoFrameMetadata: Record<string, unknown> | null;
};
export interface BestPhotosQueryOptions extends HiddenContentQueryOptions {
  ownerId: string;
  limit: number;
  page: number;
  minScore?: number;
  includeArchived?: boolean;
}
@Injectable()
export class BestPhotosRepository {
  constructor(
    @InjectKysely()
    private db: Kysely<DB>,
  ) {}
  @GenerateSql({ params: [DummyValue.UUID] })
  async getScore(assetId: string): Promise<BestPhotoScore | undefined> {
    return this.db
      .withSchema('public')
      .selectFrom('asset_best_photo_score')
      .selectAll()
      .where('assetId', '=', asUuid(assetId))
      .executeTakeFirst();
  }
  @GenerateSql({
    params: [
      {
        assetId: DummyValue.UUID,
        ownerId: DummyValue.UUID,
        score: 0.7,
        aestheticScore: 0.7,
        technicalScore: 0.7,
        subjectScore: 0.5,
        diversityScore: 0.5,
        scoreVersion: 1,
        computedAt: DummyValue.DATE,
        metadata: {},
        bestFrameTimestampMs: null,
        frameScore: null,
        frameMetadata: null,
      },
    ],
  })
  async upsertScore(score: BestPhotoScoreUpsert): Promise<void> {
    const adopt = async (db: Kysely<DB>) => {
      const asset = await db
        .selectFrom('asset')
        .select('ownerId')
        .where('id', '=', score.assetId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (asset.ownerId !== score.ownerId) {
        throw new Error('Best photo score owner mismatch');
      }
      await this.upsertInto(db, score);
    };
    if (!deferJobAdoption(adopt)) {
      await this.db.transaction().execute(adopt);
    }
  }

  private async upsertInto(db: Kysely<DB>, score: BestPhotoScoreUpsert): Promise<void> {
    await db
      .insertInto('asset_best_photo_score')
      .values(score)
      .onConflict((oc) =>
        oc.column('assetId').doUpdateSet(({ ref }) => ({
          ownerId: ref('excluded.ownerId'),
          score: ref('excluded.score'),
          aestheticScore: ref('excluded.aestheticScore'),
          technicalScore: ref('excluded.technicalScore'),
          subjectScore: ref('excluded.subjectScore'),
          diversityScore: ref('excluded.diversityScore'),
          scoreVersion: ref('excluded.scoreVersion'),
          computedAt: ref('excluded.computedAt'),
          metadata: ref('excluded.metadata'),
          bestFrameTimestampMs: ref('excluded.bestFrameTimestampMs'),
          frameScore: ref('excluded.frameScore'),
          frameMetadata: ref('excluded.frameMetadata'),
          updatedAt: sql`now()`,
        })),
      )
      .execute();
  }

  @GenerateSql({
    params: [
      {
        ownerId: DummyValue.UUID,
        limit: 100,
        page: 1,
        minScore: 0.5,
        includeArchived: false,
      },
    ],
  })
  async getBestPhotos(options: BestPhotosQueryOptions) {
    const scoreSchema = 'public';
    const query = (this.db as Kysely<any>)
      .selectFrom(`${scoreSchema}.asset_best_photo_score as asset_best_photo_score`)
      .innerJoin('public.asset as asset', 'asset.id', 'asset_best_photo_score.assetId')
      .where('asset_best_photo_score.ownerId', '=', asUuid(options.ownerId))
      .where('asset.ownerId', '=', asUuid(options.ownerId))
      .where('asset.deletedAt', 'is', null)
      .where('asset.status', '=', sql.lit(AssetStatus.Active))
      .where('asset.visibility', 'in', [
        sql.lit(AssetVisibility.Timeline),
        ...(options.includeArchived ? [sql.lit(AssetVisibility.Archive)] : []),
      ])
      // FL-195: the owner's own marks and detections rank like any other item in an unlocked session
      .where(revealedLockScope(options.revealLockedOwnerId, 'asset'))
      .where('asset.type', 'in', [sql.lit(AssetType.Image), sql.lit(AssetType.Video)])
      .$if(options.minScore !== undefined, (qb) => qb.where('asset_best_photo_score.score', '>=', options.minScore!))
      .$call((qb) => withHiddenContentFilter(qb, options));
    const [{ count }, items] = await Promise.all([
      query.select((eb) => eb.fn.countAll().as('count')).executeTakeFirstOrThrow(),
      query
        .selectAll('asset')
        .select(sql<boolean>`${isLocked('asset')}`.as('isLocked'))
        .select([
          'asset_best_photo_score.score as bestPhotoScore',
          'asset_best_photo_score.aestheticScore as bestPhotoAestheticScore',
          'asset_best_photo_score.technicalScore as bestPhotoTechnicalScore',
          'asset_best_photo_score.subjectScore as bestPhotoSubjectScore',
          'asset_best_photo_score.diversityScore as bestPhotoDiversityScore',
          'asset_best_photo_score.scoreVersion as bestPhotoScoreVersion',
          'asset_best_photo_score.computedAt as bestPhotoComputedAt',
          'asset_best_photo_score.metadata as bestPhotoMetadata',
          'asset_best_photo_score.bestFrameTimestampMs as bestPhotoBestFrameTimestampMs',
          'asset_best_photo_score.frameScore as bestPhotoFrameScore',
          'asset_best_photo_score.frameMetadata as bestPhotoFrameMetadata',
        ])
        .orderBy('asset_best_photo_score.score', 'desc')
        .orderBy('asset.fileCreatedAt', 'desc')
        .limit(options.limit + 1)
        .offset((options.page - 1) * options.limit)
        .execute(),
    ]);
    return { ...paginationHelper(items as BestPhotoAssetRow[], options.limit), total: Number(count) };
  }
  @GenerateSql({ params: [[DummyValue.UUID]] })
  async deleteForAssets(assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }
    await this.db.transaction().execute(async (trx) => {
      {
        await trx
          .withSchema('public')
          .deleteFrom('asset_best_photo_score')
          .where('assetId', '=', anyUuid(assetIds))
          .execute();
      }
    });
  }
}
