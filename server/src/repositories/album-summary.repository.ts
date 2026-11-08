import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import type { AlbumAssetCount } from 'src/repositories/album.repository.js';
import { DB } from 'src/schema/index.js';
import { AlbumSummaryTable } from 'src/schema/tables/album-summary.table.js';
import { anyUuid } from 'src/utils/database.js';

export type AlbumSummary = Pick<
  Selectable<AlbumSummaryTable>,
  'albumId' | 'assetCount' | 'startDate' | 'endDate' | 'lastModifiedAssetTimestamp' | 'computedAt'
>;

/**
 * The lowest UUIDv7 that a change made at this moment can have, so a range over `updateId` can use its
 * index. `immich_uuid_v7` will not do: it is volatile, and Postgres cannot scan an index with that.
 */
export const uuidV7Floor = (date: Date) => {
  const hex = date.getTime().toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-000000000000`;
};

@Injectable()
export class AlbumSummaryRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.STRING, [DummyValue.UUID]] })
  getByIds(viewerKey: string, albumIds: string[]): Promise<AlbumSummary[]> {
    if (albumIds.length === 0) {
      return Promise.resolve([]);
    }
    return this.db
      .selectFrom('album_summary')
      .select(['albumId', 'assetCount', 'startDate', 'endDate', 'lastModifiedAssetTimestamp', 'computedAt'])
      .where('viewerKey', '=', viewerKey)
      .where('albumId', '=', anyUuid(albumIds))
      .execute();
  }

  /**
   * When each album last changed since `since`: an item added or removed, or an item edited, trashed,
   * locked or unlocked (locking touches the asset row). An album can appear once per kind of change.
   */
  @GenerateSql({ params: [[DummyValue.UUID], DummyValue.DATE] })
  async getChangedAt(albumIds: string[], since: Date): Promise<{ albumId: string; changedAt: Date }[]> {
    if (albumIds.length === 0) {
      return [];
    }
    const updateId = uuidV7Floor(since);
    const rows = await this.db
      .selectFrom('album_asset')
      .select('album_asset.albumId')
      .select((eb) => eb.fn.max('album_asset.updatedAt').as('changedAt'))
      .where('album_asset.updateId', '>=', updateId)
      .where('album_asset.albumId', '=', anyUuid(albumIds))
      .groupBy('album_asset.albumId')
      .unionAll((eb) =>
        eb
          .selectFrom('album_asset_audit')
          .select('album_asset_audit.albumId')
          .select(({ fn }) => fn.max('album_asset_audit.deletedAt').as('changedAt'))
          .where('album_asset_audit.deletedAt', '>=', since)
          .where('album_asset_audit.albumId', '=', anyUuid(albumIds))
          .groupBy('album_asset_audit.albumId'),
      )
      .unionAll((eb) =>
        eb
          .selectFrom('asset')
          .innerJoin('album_asset', 'album_asset.assetId', 'asset.id')
          .select('album_asset.albumId')
          .select(({ fn }) => fn.max('asset.updatedAt').as('changedAt'))
          .where('asset.updateId', '>=', updateId)
          .where('album_asset.albumId', '=', anyUuid(albumIds))
          .groupBy('album_asset.albumId'),
      )
      .execute();
    return rows as { albumId: string; changedAt: Date }[];
  }

  /**
   * Stores one read of `albumIds`. An album the read returned nothing for has no item this viewer may
   * see: it gets a row of zero, or it would look not yet counted for ever.
   */
  @GenerateSql({
    params: [DummyValue.STRING, DummyValue.DATE, [DummyValue.UUID], []],
  })
  async upsert(viewerKey: string, computedAt: Date, albumIds: string[], metadata: AlbumAssetCount[]): Promise<void> {
    if (albumIds.length === 0) {
      return;
    }
    const byAlbum = new Map(metadata.map((item) => [item.albumId, item]));
    const values: Insertable<AlbumSummaryTable>[] = albumIds.map((albumId) => {
      const item = byAlbum.get(albumId);
      return {
        albumId,
        viewerKey,
        computedAt,
        assetCount: item?.assetCount ?? 0,
        startDate: item?.startDate ?? null,
        endDate: item?.endDate ?? null,
        lastModifiedAssetTimestamp: item?.lastModifiedAssetTimestamp ?? null,
      };
    });
    await this.db
      .insertInto('album_summary')
      .values(values)
      .onConflict((oc) =>
        oc.columns(['albumId', 'viewerKey']).doUpdateSet((eb) => ({
          assetCount: eb.ref('excluded.assetCount'),
          startDate: eb.ref('excluded.startDate'),
          endDate: eb.ref('excluded.endDate'),
          lastModifiedAssetTimestamp: eb.ref('excluded.lastModifiedAssetTimestamp'),
          computedAt: eb.ref('excluded.computedAt'),
        })),
      )
      .execute();
  }

  /** Clears variants nobody reads any more: one in use is recomputed at least daily. */
  @GenerateSql({ params: [DummyValue.DATE] })
  async deleteComputedBefore(date: Date): Promise<void> {
    await this.db
      .deleteFrom('album_summary')
      .where('computedAt', '<', sql<Date>`${date}`)
      .execute();
  }
}
