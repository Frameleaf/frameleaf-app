import { Kysely, Transaction, sql } from 'kysely';
import { chunk } from 'lodash-es';
import { createHash } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { SyncAck } from 'src/types.js';
import { mapPet, mapPetObservation } from 'src/dtos/pet.dto.js';
import { AlbumKind, AlbumUserRole, SyncEntityType } from 'src/enum.js';
import { lockPublicForkWrites } from 'src/repositories/fork-write-guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PetRepository } from 'src/repositories/pet.repository.js';
import { DB } from 'src/schema/index.js';
import {
  getHiddenContentFilter,
  tagHasVisibleAssetOrNoAssets,
  tagIsSuppressed,
  withHiddenContentFilter,
} from 'src/utils/database.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { getLockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { getLockedOwnerId, notLockedOrOwnedBy } from 'src/utils/locked.js';
import { toAck } from 'src/utils/sync.js';

type Kind = 'tag' | 'assetTag' | 'pet' | 'petObservation' | 'space' | 'spaceMember';
type Visible = {
  key: string;
  entityId: string;
  assetId: string | null;
  sourceId: string;
  data: Record<string, unknown>;
};
const types = {
  space: { upsert: SyncEntityType.SharedSpaceV1, delete: SyncEntityType.SharedSpaceDeleteV1 },
  spaceMember: { upsert: SyncEntityType.SharedSpaceMemberV1, delete: SyncEntityType.SharedSpaceMemberDeleteV1 },
  tag: { upsert: SyncEntityType.TagV1, delete: SyncEntityType.TagDeleteV1 },
  assetTag: { upsert: SyncEntityType.AssetTagV1, delete: SyncEntityType.AssetTagDeleteV1 },
  pet: { upsert: SyncEntityType.PetV1, delete: SyncEntityType.PetDeleteV1 },
  petObservation: { upsert: SyncEntityType.PetObservationV1, delete: SyncEntityType.PetObservationDeleteV1 },
} as const;

/** Only the additive tag/pet types have delivery IDs. Existing sync cursors are untouched. */
export class TagSync {
  constructor(private db: Kysely<DB>) {}

  private async locked<T>(sessionId: string, run: (tx: Transaction<DB>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (tx) => {
      await lockPublicForkWrites(tx);
      await sql`select pg_advisory_xact_lock(hashtextextended(${`tag-sync:${sessionId}`}, 0))`.execute(tx);
      return run(tx);
    });
  }

  private async visible(db: Kysely<DB>, kind: Kind, auth: AuthDto, key?: string): Promise<Visible[]> {
    const options = getHiddenContentQueryOptions(auth);
    if (kind === 'space' || kind === 'spaceMember') {
      if (auth.sharedLink) return [];
      const spaces = db
        .selectFrom('album')
        .innerJoin('album_user as caller', 'caller.albumId', 'album.id')
        .innerJoin('album_user as ownership', 'ownership.albumId', 'album.id')
        .innerJoin('user as owner', 'owner.id', 'ownership.userId')
        .innerJoin('user as reader', 'reader.id', 'caller.userId')
        .where('album.kind', '=', AlbumKind.Space)
        .where('ownership.role', '=', AlbumUserRole.Owner)
        .where('album.deletedAt', 'is', null)
        .where('owner.deletedAt', 'is', null)
        .where('reader.deletedAt', 'is', null)
        .where('caller.userId', '=', auth.user.id);
      if (kind === 'space') {
        return spaces
          .$if(!!key, (qb) => qb.where('album.id', '=', key!))
          .select(['album.id as key', 'album.id as entityId', 'album.updateId as sourceId'])
          .select([
            sql<null>`null`.as('assetId'),
            sql<
              Record<string, unknown>
            >`jsonb_build_object('id', album.id, 'name', album."albumName", 'description', album.description, 'icon', album.icon, 'kind', album.kind, 'createdAt', album."createdAt", 'updatedAt', album."updatedAt")`.as(
              'data',
            ),
          ])
          .execute();
      }
      return spaces
        .innerJoin('album_user as member', 'member.albumId', 'album.id')
        .innerJoin('user as accepted', 'accepted.id', 'member.userId')
        .where('accepted.deletedAt', 'is', null)
        .$if(!!key, (qb) =>
          qb.where('album.id', '=', key!.split(':', 1)[0]).where('member.userId', '=', key!.split(':', 2)[1]),
        )
        .select(['album.id as entityId', 'member.updateId as sourceId'])
        .select([
          sql<string>`album.id::text || ':' || member."userId"::text`.as('key'),
          sql<null>`null`.as('assetId'),
          sql<
            Record<string, unknown>
          >`jsonb_build_object('spaceId', album.id, 'userId', member."userId", 'role', member.role, 'createdAt', member."createdAt", 'updatedAt', member."updatedAt")`.as(
            'data',
          ),
        ])
        .execute();
    }
    if (kind === 'pet' || kind === 'petObservation') {
      const pets = new PetRepository(db, LoggingRepository.create());
      const visiblePets = await pets.getAll(auth.user.id, {
        withHidden: false,
        forSync: true,
        id: kind === 'pet' ? key : undefined,
        ...options,
        ...getLockedVisibilityOptions(auth),
      });
      if (kind === 'pet')
        return visiblePets.map((pet) => {
          const data = mapPet(pet);
          const digest = createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 32);
          const sourceId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
          return { key: pet.id, entityId: pet.id, assetId: null, sourceId, data: { ...data } };
        });
      if (visiblePets.length === 0) return [];
      const observations = await pets.getObservations(
        auth.user.id,
        visiblePets.map((pet) => pet.id),
        {
          forSync: true,
          observationId: key,
          ...options,
          ...getLockedVisibilityOptions(auth),
        },
      );
      return observations.map((row) => ({
        key: row.id,
        entityId: row.petId,
        assetId: row.assetId,
        sourceId: row.updateId,
        data: { ...mapPetObservation(row) },
      }));
    }

    const suppressed = options.hiddenContent?.tagIds ?? [];
    const tagVisible = sql<boolean>`(${tagHasVisibleAssetOrNoAssets(sql.ref('tag.id'), getHiddenContentFilter(options), { hideLocked: !getLockedOwnerId(auth) })}) and not ${tagIsSuppressed(sql.ref('tag.id'), suppressed)}`;
    if (kind === 'tag') {
      return db
        .selectFrom('tag')
        .where('tag.userId', '=', auth.user.id)
        .$if(!!key, (qb) => qb.where('tag.id', '=', key!))
        .where(tagVisible)
        .select(['tag.id as key', 'tag.id as entityId', 'tag.updateId as sourceId'])
        .select([
          sql<null>`null`.as('assetId'),
          sql<
            Record<string, unknown>
          >`jsonb_build_object('id', tag.id, 'userId', tag."userId", 'value', tag.value, 'parentId', tag."parentId", 'color', tag.color, 'createdAt', tag."createdAt", 'updatedAt', tag."updatedAt")`.as(
            'data',
          ),
        ])
        .execute();
    }
    return db
      .selectFrom('tag_asset')
      .innerJoin('tag', 'tag.id', 'tag_asset.tagId')
      .innerJoin('asset', 'asset.id', 'tag_asset.assetId')
      .where('tag.userId', '=', auth.user.id)
      .$if(!!key, (qb) =>
        qb.where('tag_asset.tagId', '=', key!.split(':', 1)[0]).where('tag_asset.assetId', '=', key!.split(':', 2)[1]),
      )
      .where('asset.ownerId', '=', auth.user.id)
      .where('asset.deletedAt', 'is', null)
      .where(tagVisible)
      .where(notLockedOrOwnedBy(getLockedOwnerId(auth)))
      .$call((qb) => withHiddenContentFilter(qb, options))
      .select(['tag_asset.tagId as entityId', 'tag_asset.assetId', 'tag_asset.updateId as sourceId'])
      .select([
        sql<string>`tag_asset."tagId"::text || ':' || tag_asset."assetId"::text`.as('key'),
        sql<Record<string, unknown>>`jsonb_build_object('tagId', tag_asset."tagId", 'assetId', tag_asset."assetId")`.as(
          'data',
        ),
      ])
      .execute();
  }

  async reconcile(auth: AuthDto, kind: Kind) {
    const sessionId = auth.session!.id;
    return this.locked(sessionId, async (tx) => {
      const visible = new Map((await this.visible(tx, kind, auth)).map((row) => [row.key, row]));
      const stored = await tx
        .selectFrom('session_tag_sync_state')
        .selectAll()
        .where('sessionId', '=', sessionId)
        .where('kind', '=', kind)
        .execute();
      for (const state of stored) {
        const current = visible.get(state.key);
        visible.delete(state.key);
        if (current) {
          if (
            state.action === 'delete' ||
            current.sourceId !== state.sourceId ||
            current.entityId !== state.entityId ||
            current.assetId !== state.assetId
          ) {
            await tx
              .updateTable('session_tag_sync_state')
              .set({
                entityId: current.entityId,
                assetId: current.assetId,
                sourceId: current.sourceId,
                action: 'upsert',
                eventId: sql`immich_uuid_v7()`,
                delivered: false,
                acknowledged: false,
              })
              .$if(kind === 'space', (qb) => qb.set({ deliveryOrder: null }))
              .where('sessionId', '=', sessionId)
              .where('kind', '=', kind)
              .where('key', '=', state.key)
              .execute();
          }
        } else if (state.potentiallyVisible || state.confirmedVisible) {
          if (state.action !== 'delete') {
            await tx
              .updateTable('session_tag_sync_state')
              .set({ action: 'delete', eventId: sql`immich_uuid_v7()`, delivered: false, acknowledged: false })
              .$if(kind === 'space', (qb) => qb.set({ deliveryOrder: null }))
              .where('sessionId', '=', sessionId)
              .where('kind', '=', kind)
              .where('key', '=', state.key)
              .execute();
          }
        } else {
          // Queued rows never sent must not disclose their identifiers when they become hidden.
          await tx
            .deleteFrom('session_tag_sync_state')
            .where('sessionId', '=', sessionId)
            .where('kind', '=', kind)
            .where('key', '=', state.key)
            .execute();
        }
      }
      for (const rows of chunk(visible.values().toArray(), 1000)) {
        await tx
          .insertInto('session_tag_sync_state')
          .values(
            rows.map((current) => ({
              sessionId,
              kind,
              key: current.key,
              entityId: current.entityId,
              assetId: current.assetId,
              sourceId: current.sourceId,
              action: 'upsert' as const,
            })),
          )
          .execute();
      }
      return (
        tx
          .selectFrom('session_tag_sync_state')
          .selectAll()
          .where('sessionId', '=', sessionId)
          .where('kind', '=', kind)
          .where('acknowledged', '=', false)
          // Delivery ACKs never confirm unsent rows, so ordering identity independently cannot skip older entries.
          .$if(kind === 'space', (qb) =>
            qb
              .orderBy(sql`"deliveryOrder" asc nulls last`)
              .orderBy(
                sql`(select album."createdAt" from album where album.id = session_tag_sync_state."entityId") desc nulls last`,
              )
              .orderBy('entityId', 'desc'),
          )
          .orderBy('eventId', 'asc')
          .execute()
      );
    });
  }

  async prepare(auth: AuthDto, kind: Kind, eventId: string) {
    const sessionId = auth.session!.id;
    return this.locked(sessionId, async (tx) => {
      const state = await tx
        .selectFrom('session_tag_sync_state')
        .selectAll()
        .where('sessionId', '=', sessionId)
        .where('kind', '=', kind)
        .where('eventId', '=', eventId)
        .where('acknowledged', '=', false)
        .executeTakeFirst();
      if (!state) return;
      const current = (await this.visible(tx, kind, auth, state.key)).find((row) => row.key === state.key);
      if ((state.action === 'upsert' && !current) || (state.action === 'delete' && current)) return;
      // A source changing after reconciliation needs a new generation before any payload is sent.
      if (
        state.action === 'upsert' &&
        (current!.sourceId !== state.sourceId ||
          current!.entityId !== state.entityId ||
          current!.assetId !== state.assetId)
      )
        return;
      await tx
        .updateTable('session_tag_sync_state')
        .set({ delivered: true, potentiallyVisible: true })
        .$if(kind === 'space' && state.deliveryOrder === null, (qb) =>
          qb.set({
            deliveryOrder: sql<number>`(select coalesce(max("deliveryOrder"), 0) + 1 from session_tag_sync_state where "sessionId" = ${sessionId} and kind = ${kind})`,
          }),
        )
        .where('sessionId', '=', sessionId)
        .where('kind', '=', kind)
        .where('key', '=', state.key)
        .where('eventId', '=', eventId)
        .where('action', '=', state.action)
        .execute();
      return {
        eventId,
        type: types[kind][state.action],
        data:
          state.action === 'upsert'
            ? current!.data
            : kind === 'space'
              ? { spaceId: state.entityId }
              : kind === 'spaceMember'
                ? { spaceId: state.entityId, userId: state.key.split(':', 2)[1] }
                : kind === 'tag'
                  ? { tagId: state.entityId }
                  : kind === 'assetTag'
                    ? { tagId: state.entityId, assetId: state.assetId! }
                    : kind === 'pet'
                      ? { petId: state.entityId }
                      : { observationId: state.key, petId: state.entityId, assetId: state.assetId! },
      };
    });
  }

  async acknowledge(sessionId: string, ack: SyncAck): Promise<boolean> {
    const kind = Object.keys(types).find((k) =>
      (Object.values(types[k as Kind]) as SyncEntityType[]).includes(ack.type),
    ) as Kind | undefined;
    if (!kind) return false;
    const action = ack.type === types[kind].upsert ? 'upsert' : 'delete';
    await this.locked(sessionId, async (tx) => {
      // Stale/forged ACKs cannot confirm a different action or a later regrant with the same key.
      const exact = await tx
        .selectFrom('session_tag_sync_state')
        .selectAll()
        .where('sessionId', '=', sessionId)
        .where('kind', '=', kind)
        .where('eventId', '=', ack.updateId)
        .where('action', '=', action)
        .where('delivered', '=', true)
        .executeTakeFirst();
      if (!exact || (kind === 'space' && exact.deliveryOrder === null)) return;
      const pending = tx
        .selectFrom('session_tag_sync_state')
        .select('key')
        .where('sessionId', '=', sessionId)
        .where('kind', '=', kind)
        .$if(kind === 'space', (qb) => qb.where('deliveryOrder', '<=', exact.deliveryOrder!))
        .$if(kind !== 'space', (qb) => qb.where('eventId', '<=', ack.updateId))
        .where('action', '=', action)
        .where('delivered', '=', true);
      if (action === 'delete') {
        await tx
          .deleteFrom('session_tag_sync_state')
          .where('sessionId', '=', sessionId)
          .where('kind', '=', kind)
          .where('key', 'in', pending)
          .execute();
      } else {
        await tx
          .updateTable('session_tag_sync_state')
          .set({ acknowledged: true, confirmedVisible: true })
          .where('sessionId', '=', sessionId)
          .where('kind', '=', kind)
          .where('key', 'in', pending)
          .execute();
      }
      await tx
        .insertInto('session_sync_checkpoint')
        .values({ sessionId, type: ack.type, ack: toAck(ack) })
        .onConflict((oc) => oc.columns(['sessionId', 'type']).doUpdateSet({ ack: toAck(ack) }))
        .execute();
    });
    return true;
  }

  async cleanupAuditTables(days: number) {
    // Official-origin libraries do not have legacy-fork public additions until adoption.
    const { rows } = await sql<{ table: string | null }>`select to_regclass('public.tag_audit')::text as table`.execute(
      this.db,
    );
    if (!rows[0]?.table) return;
    await this.db.transaction().execute(async (tx) => {
      await lockPublicForkWrites(tx);
      await tx
        .deleteFrom('tag_audit')
        .where('deletedAt', '<', sql<Date>`now() - ${days} * interval '1 day'`)
        .execute();
      await tx
        .deleteFrom('tag_asset_audit')
        .where('deletedAt', '<', sql<Date>`now() - ${days} * interval '1 day'`)
        .execute();
      const { rows: petTables } = await sql<{
        table: string | null;
      }>`select to_regclass('public.pet_audit')::text as table`.execute(tx);
      if (petTables[0]?.table) {
        await tx
          .deleteFrom('pet_audit')
          .where('deletedAt', '<', sql<Date>`now() - ${days} * interval '1 day'`)
          .execute();
        await tx
          .deleteFrom('pet_observation_audit')
          .where('deletedAt', '<', sql<Date>`now() - ${days} * interval '1 day'`)
          .execute();
      }
    });
  }

  async reset(sessionId: string, requested?: SyncEntityType[]) {
    const kinds = (Object.keys(types) as Kind[]).filter(
      (kind) => !requested || Object.values(types[kind]).some((type) => requested.includes(type)),
    );
    if (kinds.length === 0) return;
    const { rows } = await sql<{
      table: string | null;
    }>`select to_regclass('public.session_tag_sync_state')::text as table`.execute(this.db);
    if (!rows[0]?.table) return;
    await this.locked(sessionId, async (tx) => {
      await tx
        .deleteFrom('session_tag_sync_state')
        .where('sessionId', '=', sessionId)
        .where('kind', 'in', kinds)
        .execute();
    });
  }
}
