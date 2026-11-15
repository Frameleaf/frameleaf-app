import { Kysely, sql } from 'kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AssetOrder } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { asUuid } from 'src/utils/database.js';

/** Below this gap between neighbours the album is renumbered 1..n before placing (FL-869). */
export const MIN_POSITION_GAP = 1e-9;

/** Where to put photos or a card: after a photo, after a card, at the start (both null) or at the end. */
export type AlbumPlacement = 'end' | { afterAssetId?: string | null; afterTextCardId?: string | null };

export type AlbumTextCardRow = {
  id: string;
  albumId: string;
  position: number;
  heading: string;
  body: string;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  afterAssetId: string | null;
};

/**
 * Splits [lower, upper] evenly into `count` new places. Pure, so the arithmetic is tested on its own; null when
 * the gap is too small and the album needs renumbering first.
 */
export const spreadPositions = (lower: number | null, upper: number | null, count: number): number[] | null => {
  const from = lower ?? (upper === null ? 0 : upper - 1);
  const to = upper ?? from + 1;
  const step = (to - from) / (count + 1);
  if (!(step >= MIN_POSITION_GAP)) {
    return null;
  }
  return Array.from({ length: count }, (_, index) => from + step * (index + 1));
};

/**
 * FL-869 / FL-881: an album's custom order. Photos (album_asset.position) and text cards (album_text_card.position)
 * share one number line, so a card sits between the photos either side of it.
 */
export class AlbumOrderRepository {
  constructor(private db: Kysely<DB>) {}

  /**
   * Gives every photo without a place one after the album's last item, in the album's date order. The first time
   * an album switches to custom order this seeds the whole album from its date order; later it appends photos that
   * arrived while the album was in date order, or by a path that did not place them.
   */
  @GenerateSql({ params: [DummyValue.UUID, AssetOrder.Desc] })
  async placeUnplaced(albumId: string, order: AssetOrder, db: Kysely<DB> = this.db): Promise<void> {
    const direction = sql.raw(order === AssetOrder.Asc ? 'asc' : 'desc');
    await sql`
      with base as (
        select greatest(
          (select max(position) from album_asset where "albumId" = ${asUuid(albumId)}),
          (select max(position) from album_text_card where "albumId" = ${asUuid(albumId)}),
          0
        ) as last
      ), ranked as (
        select album_asset."assetId", row_number() over (order by asset."fileCreatedAt" ${direction}, asset.id) as rank
        from album_asset
        inner join asset on asset.id = album_asset."assetId"
        where album_asset."albumId" = ${asUuid(albumId)} and album_asset.position is null
      )
      update album_asset
      set position = base.last + ranked.rank
      from ranked, base
      where album_asset."albumId" = ${asUuid(albumId)} and album_asset."assetId" = ranked."assetId"
    `.execute(db);
  }

  /** Renumbers photos and cards 1..n in their current order, keeping unplaced photos unplaced. */
  @GenerateSql({ params: [DummyValue.UUID] })
  async renumber(albumId: string, db: Kysely<DB> = this.db): Promise<void> {
    await sql`
      with items as (
        select 'asset' as kind, "assetId" as id, position from album_asset
        where "albumId" = ${asUuid(albumId)} and position is not null
        union all
        select 'card' as kind, id, position from album_text_card where "albumId" = ${asUuid(albumId)}
      ), ranked as (
        select kind, id, row_number() over (order by position, kind, id) as rank from items
      ), assets as (
        update album_asset set position = ranked.rank
        from ranked
        where ranked.kind = 'asset' and album_asset."albumId" = ${asUuid(albumId)} and album_asset."assetId" = ranked.id
      )
      update album_text_card set position = ranked.rank
      from ranked
      where ranked.kind = 'card' and album_text_card."albumId" = ${asUuid(albumId)} and album_text_card.id = ranked.id
    `.execute(db);
  }

  /** The asset ids among `assetIds` that are in the album. */
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  async getMembers(albumId: string, assetIds: string[], db: Kysely<DB> = this.db): Promise<Set<string>> {
    if (assetIds.length === 0) {
      return new Set();
    }
    const rows = await db
      .selectFrom('album_asset')
      .select('assetId')
      .where('albumId', '=', asUuid(albumId))
      .where('assetId', '=', sql<string>`any(${assetIds}::uuid[])`)
      .execute();
    return new Set(rows.map(({ assetId }) => assetId));
  }

  /** The [lower, upper] bounds for a placement, leaving out the items being moved. */
  private async bounds(
    db: Kysely<DB>,
    albumId: string,
    placement: AlbumPlacement,
    moving: { assetIds: string[]; cardIds: string[] },
  ): Promise<{ lower: number | null; upper: number | null } | undefined> {
    const lastOf = await sql<{ position: number | null }>`
      select greatest(
        (select max(position) from album_asset
          where "albumId" = ${asUuid(albumId)} and not ("assetId" = any(${moving.assetIds}::uuid[]))),
        (select max(position) from album_text_card
          where "albumId" = ${asUuid(albumId)} and not (id = any(${moving.cardIds}::uuid[])))
      ) as position
    `.execute(db);
    if (placement === 'end') {
      return { lower: lastOf.rows[0]?.position ?? null, upper: null };
    }

    let lower: number | null = null;
    if (placement.afterTextCardId) {
      const card = await db
        .selectFrom('album_text_card')
        .select('position')
        .where('albumId', '=', asUuid(albumId))
        .where('id', '=', asUuid(placement.afterTextCardId))
        .executeTakeFirst();
      if (!card) {
        return undefined;
      }
      lower = card.position;
    } else if (placement.afterAssetId) {
      const asset = await db
        .selectFrom('album_asset')
        .select('position')
        .where('albumId', '=', asUuid(albumId))
        .where('assetId', '=', asUuid(placement.afterAssetId))
        .executeTakeFirst();
      if (!asset || asset.position === null) {
        return undefined;
      }
      lower = asset.position;
    }

    const next = await sql<{ position: number | null }>`
      select least(
        (select min(position) from album_asset
          where "albumId" = ${asUuid(albumId)} and not ("assetId" = any(${moving.assetIds}::uuid[]))
            and (${lower}::double precision is null or position > ${lower}::double precision)),
        (select min(position) from album_text_card
          where "albumId" = ${asUuid(albumId)} and not (id = any(${moving.cardIds}::uuid[]))
            and (${lower}::double precision is null or position > ${lower}::double precision))
      ) as position
    `.execute(db);
    return { lower, upper: next.rows[0]?.position ?? null };
  }

  /**
   * Places photos and cards, in the given order, at `placement`. Serialised per album with a row lock so two editors
   * dragging at once never interleave. Returns false when the anchor is not in the album.
   */
  async place(
    albumId: string,
    order: AssetOrder,
    placement: AlbumPlacement,
    moving: { assetIds: string[]; cardIds: string[] },
  ): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      await tx.selectFrom('album').select('id').where('id', '=', asUuid(albumId)).forUpdate().execute();
      await this.placeUnplaced(albumId, order, tx);
      const count = moving.assetIds.length + moving.cardIds.length;
      let bounds = await this.bounds(tx, albumId, placement, moving);
      if (!bounds) {
        return false;
      }
      let positions = spreadPositions(bounds.lower, bounds.upper, count);
      if (!positions) {
        await this.renumber(albumId, tx);
        bounds = await this.bounds(tx, albumId, placement, moving);
        positions = bounds && spreadPositions(bounds.lower, bounds.upper, count);
        if (!positions) {
          throw new Error('Could not place items after renumbering the album');
        }
      }
      const assetPositions = positions.slice(0, moving.assetIds.length);
      const cardPositions = positions.slice(moving.assetIds.length);
      if (moving.assetIds.length > 0) {
        await sql`
          update album_asset set position = placed.position
          from unnest(${moving.assetIds}::uuid[], ${assetPositions}::double precision[]) as placed("assetId", position)
          where album_asset."albumId" = ${asUuid(albumId)} and album_asset."assetId" = placed."assetId"
        `.execute(tx);
      }
      if (moving.cardIds.length > 0) {
        await sql`
          update album_text_card set position = placed.position
          from unnest(${moving.cardIds}::uuid[], ${cardPositions}::double precision[]) as placed(id, position)
          where album_text_card."albumId" = ${asUuid(albumId)} and album_text_card.id = placed.id
        `.execute(tx);
      }
      return true;
    });
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getTextCards(albumId: string, cardIds?: string[]): Promise<AlbumTextCardRow[]> {
    return this.db
      .selectFrom('album_text_card')
      .select([
        'album_text_card.id',
        'album_text_card.albumId',
        'album_text_card.position',
        'album_text_card.heading',
        'album_text_card.body',
        'album_text_card.createdById',
        'album_text_card.createdAt',
        'album_text_card.updatedAt',
      ])
      .select((eb) =>
        eb
          .selectFrom('album_asset')
          .select('album_asset.assetId')
          .whereRef('album_asset.albumId', '=', 'album_text_card.albumId')
          .whereRef('album_asset.position', '<', 'album_text_card.position')
          .orderBy('album_asset.position', 'desc')
          .limit(1)
          .as('afterAssetId'),
      )
      .where('album_text_card.albumId', '=', asUuid(albumId))
      .$if(!!cardIds, (qb) => qb.where('album_text_card.id', '=', sql<string>`any(${cardIds}::uuid[])`))
      .orderBy('album_text_card.position')
      .orderBy('album_text_card.id')
      .execute() as Promise<AlbumTextCardRow[]>;
  }

  /** Adds a card at the end of the album; the service places it afterwards. */
  async createTextCard(values: {
    albumId: string;
    heading: string;
    body: string;
    createdById: string;
  }): Promise<string> {
    const { id } = await this.db
      .insertInto('album_text_card')
      .values({
        ...values,
        position: sql<number>`greatest(
          (select max(position) from album_asset where "albumId" = ${asUuid(values.albumId)}),
          (select max(position) from album_text_card where "albumId" = ${asUuid(values.albumId)}),
          0
        ) + 1`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return id;
  }

  async updateTextCard(albumId: string, id: string, values: { heading: string; body: string }): Promise<boolean> {
    const result = await this.db
      .updateTable('album_text_card')
      .set(values)
      .where('albumId', '=', asUuid(albumId))
      .where('id', '=', asUuid(id))
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  /** Deletes the card only; photos are never touched. */
  async deleteTextCard(albumId: string, id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('album_text_card')
      .where('albumId', '=', asUuid(albumId))
      .where('id', '=', asUuid(id))
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }
}
