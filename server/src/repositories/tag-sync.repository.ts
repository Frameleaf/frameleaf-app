import { Kysely, Transaction, sql } from 'kysely';
import { chunk } from 'lodash-es';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { SyncAck } from 'src/types.js';
import { SyncEntityType } from 'src/enum.js';
import { lockPublicForkWrites } from 'src/repositories/fork-write-guard.js';
import { DB } from 'src/schema/index.js';
import {
  getHiddenContentFilter,
  tagHasVisibleAssetOrNoAssets,
  tagIsSuppressed,
  withHiddenContentFilter,
} from 'src/utils/database.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { getLockedOwnerId, notLockedOrOwnedBy } from 'src/utils/locked.js';
import { toAck } from 'src/utils/sync.js';

type Kind = 'tag' | 'assetTag';
type Visible = { key: string; tagId: string; assetId: string | null; sourceId: string; data: Record<string, unknown> };
const types = {
  tag: { upsert: SyncEntityType.TagV1, delete: SyncEntityType.TagDeleteV1 },
  assetTag: { upsert: SyncEntityType.AssetTagV1, delete: SyncEntityType.AssetTagDeleteV1 },
} as const;

/** Only the additive tag types have delivery IDs. Existing sync cursors are untouched. */
export class TagSync {
  constructor(private db: Kysely<DB>) {}

  private async locked<T>(sessionId: string, run: (tx: Transaction<DB>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (tx) => {
      await lockPublicForkWrites(tx);
      await sql`select pg_advisory_xact_lock(hashtextextended(${`tag-sync:${sessionId}`}, 0))`.execute(tx);
      return run(tx);
    });
  }

  private visible(db: Kysely<DB>, kind: Kind, auth: AuthDto, key?: string): Promise<Visible[]> {
    const options = getHiddenContentQueryOptions(auth);
    const suppressed = options.hiddenContent?.tagIds ?? [];
    const tagVisible = sql<boolean>`(${tagHasVisibleAssetOrNoAssets(sql.ref('tag.id'), getHiddenContentFilter(options), { hideLocked: !getLockedOwnerId(auth) })}) and not ${tagIsSuppressed(sql.ref('tag.id'), suppressed)}`;
    if (kind === 'tag') {
      return db
        .selectFrom('tag')
        .where('tag.userId', '=', auth.user.id)
        .$if(!!key, (qb) => qb.where('tag.id', '=', key!))
        .where(tagVisible)
        .select(['tag.id as key', 'tag.id as tagId', 'tag.updateId as sourceId'])
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
      .select(['tag_asset.tagId', 'tag_asset.assetId', 'tag_asset.updateId as sourceId'])
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
          if (state.action === 'delete' || current.sourceId !== state.sourceId) {
            await tx
              .updateTable('session_tag_sync_state')
              .set({
                sourceId: current.sourceId,
                action: 'upsert',
                eventId: sql`immich_uuid_v7()`,
                delivered: false,
                acknowledged: false,
              })
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
              tagId: current.tagId,
              assetId: current.assetId,
              sourceId: current.sourceId,
              action: 'upsert' as const,
            })),
          )
          .execute();
      }
      return tx
        .selectFrom('session_tag_sync_state')
        .selectAll()
        .where('sessionId', '=', sessionId)
        .where('kind', '=', kind)
        .where('acknowledged', '=', false)
        .orderBy('eventId', 'asc')
        .execute();
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
      await tx
        .updateTable('session_tag_sync_state')
        .set({ delivered: true, potentiallyVisible: true })
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
            : kind === 'tag'
              ? { tagId: state.tagId }
              : { tagId: state.tagId, assetId: state.assetId! },
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
        .select('key')
        .where('sessionId', '=', sessionId)
        .where('kind', '=', kind)
        .where('eventId', '=', ack.updateId)
        .where('action', '=', action)
        .where('delivered', '=', true)
        .executeTakeFirst();
      if (!exact) return;
      const pending = tx
        .selectFrom('session_tag_sync_state')
        .select('key')
        .where('sessionId', '=', sessionId)
        .where('kind', '=', kind)
        .where('eventId', '<=', ack.updateId)
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
