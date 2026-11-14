import { BadRequestException, GoneException, Injectable } from '@nestjs/common';
import { type Insertable, Kysely, type Selectable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash, randomBytes } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ConnectEventPageDto, ConnectEventSampleDto } from 'src/dtos/connect-event.dto.js';
import type { DB } from 'src/schema/index.js';
import type { ConnectEventCursorTable } from 'src/schema/tables/connect-event.table.js';
import { type ConnectEventType, connectEventBinding, toConnectEventPayload } from 'src/utils/connect-events.js';
import {
  connectAssetPredicate,
  connectOwnedAlbumPredicate,
  refreshConnectAuth,
  requireConnectPolicy,
  requireConnectScope,
} from 'src/utils/connect-policy.js';
import { hiddenFromSession } from 'src/utils/database.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { isDefaultVisible } from 'src/utils/locked.js';

export type ConnectEventQuery = {
  cursor?: string;
  type?: ConnectEventType;
  albumId?: string;
  limit?: number;
  start?: 'now';
};
type Cursor = Selectable<ConnectEventCursorTable>;
type Filter = { type?: ConnectEventType | null; albumId?: string | null };
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const expired = () => new GoneException('This event cursor has expired or its access has changed');
const tokenHash = (token: string) => createHash('sha256').update(token).digest();

@Injectable()
export class ConnectEventRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  async read(
    auth: AuthDto,
    query: ConnectEventQuery = {},
    mode: 'oldest' | 'latest' = 'oldest',
  ): Promise<ConnectEventPageDto> {
    const limit = mode === 'latest' ? 100 : (query.limit ?? 100);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (query.cursor && query.start))
      throw new BadRequestException('Invalid event page');
    // The watermark, policy and rows must describe one snapshot even while retention is deleting.
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (db) => {
        auth = await refreshConnectAuth(db, auth);
        requireConnectScope(auth, 'events:read');
        const binding = connectEventBinding(auth);
        const stream = await this.watermark(db, auth.user.id);
        let cursor: Cursor | undefined;
        if (query.cursor) {
          if (!/^[\w-]{43}$/.test(query.cursor)) throw expired();
          cursor = await db
            .selectFrom('connect_event_cursor')
            .selectAll()
            .where('tokenHash', '=', tokenHash(query.cursor))
            .executeTakeFirst();
          if (
            !cursor ||
            cursor.ownerId !== auth.user.id ||
            cursor.grantId !== auth.oauthApp!.grantId ||
            cursor.binding !== binding ||
            cursor.mode !== mode ||
            new Date(cursor.expiresAt).getTime() <= Date.now() ||
            (query.type !== undefined && query.type !== cursor.type) ||
            (query.albumId !== undefined && query.albumId !== cursor.albumId) ||
            (mode === 'oldest'
              ? BigInt(cursor.position) < BigInt(stream.floor)
              : BigInt(cursor.floor) < BigInt(stream.floor))
          )
            throw expired();
        }
        const filter = cursor ?? query;
        const state: Omit<Insertable<ConnectEventCursorTable>, 'tokenHash'> = {
          ownerId: auth.user.id,
          grantId: auth.oauthApp!.grantId,
          binding,
          mode,
          type: filter.type ?? null,
          albumId: filter.albumId ?? null,
          position: cursor?.position ?? stream.position,
          floor: cursor?.floor ?? stream.floor,
          ceiling: cursor?.ceiling ?? (mode === 'latest' ? stream.position : null),
          remaining: cursor?.remaining ?? (mode === 'latest' ? 1000 : null),
          expiresAt: new Date(Date.now() + RETENTION_MS),
        };
        if (!cursor && mode === 'oldest')
          return { items: [], nextCursor: await this.saveCursor(db, state), hasMore: false, bounded: false };
        const remaining = mode === 'latest' ? state.remaining! : limit;
        const take = Math.min(limit, remaining);
        let selection = this.visible(db, auth, filter).where(
          'connect_event.position',
          '>',
          mode === 'latest' ? state.floor : stream.floor,
        );
        selection =
          mode === 'latest'
            ? selection
                .where('connect_event.position', '<=', state.ceiling!)
                .$if(!!cursor, (qb) => qb.where('connect_event.position', '<', state.position))
                .orderBy('connect_event.position', 'desc')
            : selection.where('connect_event.position', '>', state.position).orderBy('connect_event.position', 'asc');
        const rows = await selection.limit(mode === 'latest' && !cursor ? 1000 : take + 1).execute();
        // Expiry outside this bounded window must not invalidate an intact newest-first scan.
        if (mode === 'latest' && !cursor && rows.length > 0)
          state.floor = (BigInt(rows.at(-1)!.position) - 1n).toString();
        const items = rows.slice(0, take);
        const hasMore = rows.length > take && (mode !== 'latest' || remaining > take);
        if (mode === 'latest' && !hasMore)
          return {
            items: items.map((row) => toConnectEventPayload(row)),
            nextCursor: null,
            hasMore: false,
            bounded: true,
          };
        state.position = hasMore ? items.at(-1)!.position : stream.position;
        if (mode === 'latest') state.remaining = remaining - items.length;
        return {
          items: items.map((row) => toConnectEventPayload(row)),
          nextCursor: await this.saveCursor(db, state),
          hasMore,
          bounded: mode === 'latest',
        };
      });
  }

  async sample(auth: AuthDto, filter: Filter = {}): Promise<ConnectEventSampleDto> {
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (db) => {
        auth = await refreshConnectAuth(db, auth);
        requireConnectScope(auth, 'events:read');
        const stream = await this.watermark(db, auth.user.id);
        const rows = await this.visible(db, auth, filter)
          .where('connect_event.position', '>', stream.floor)
          .orderBy('connect_event.position', 'desc')
          .limit(1)
          .execute();
        return { items: rows.map((row) => toConnectEventPayload(row)) };
      });
  }

  private visible(db: Kysely<DB>, auth: AuthDto, filter: Filter) {
    const policy = requireConnectPolicy(auth);
    const readableAlbum = (alias: string) =>
      sql<boolean>`${connectOwnedAlbumPredicate(auth.user.id, alias)} and (${policy.allLibraryRead} or ${sql.ref(`${alias}.id`)}::text = any(${policy.readAlbumIds}::text[]))`;
    const hiddenSource = hiddenFromSession(
      { ...getHiddenContentQueryOptions(auth), othersRulesViewerId: auth.user.id },
      'event_source_asset',
    );
    return db
      .selectFrom('connect_event')
      .innerJoin('asset', 'asset.id', 'connect_event.assetId')
      .selectAll('connect_event')
      .where('connect_event.ownerId', '=', auth.user.id)
      .where(connectAssetPredicate(auth))
      .where(
        sql<boolean>`(connect_event."albumId" is null or exists (
        select 1 from album event_album join album_asset event_membership on event_membership."albumId"=event_album.id
        where event_album.id=connect_event."albumId" and event_membership."assetId"=asset.id and ${readableAlbum('event_album')}))`,
      )
      .where(
        sql<boolean>`(connect_event."versionId" is null or exists (
        select 1 from studio_export_version event_version where event_version.id=connect_event."versionId"
          and event_version."ownerId"=${auth.user.id}::uuid and event_version.state='published'
          and event_version."resultAssetId"=asset.id and coalesce(event_version.privacy->>'lockReason','')=''
          and not exists (select 1 from studio_export_version_source event_source
            left join asset event_source_asset on event_source_asset.id=event_source."assetId"
            where event_source."versionId"=event_version.id and event_source."assetId" is not null
              and (event_source_asset.id is null or event_source_asset."deletedAt" is not null
                or event_source_asset.status<>'active' or event_source_asset."ownerId" is distinct from event_source."ownerId"
                or not ${isDefaultVisible('event_source_asset')} or ${hiddenSource}))))`,
      )
      .$if(!!filter.type, (qb) => qb.where('connect_event.event', '=', filter.type!))
      .$if(!!filter.albumId, (qb) =>
        qb.where(sql<boolean>`(connect_event."albumId" is null or connect_event."albumId"=${filter.albumId}::uuid)
        and exists(select 1 from album filter_album join album_asset filter_member on filter_member."albumId"=filter_album.id
          where filter_album.id=${filter.albumId}::uuid and filter_member."assetId"=asset.id and ${readableAlbum('filter_album')})`),
      );
  }

  private async watermark(db: Kysely<DB>, ownerId: string) {
    const stream = await db
      .selectFrom('connect_event_stream')
      .select(['position', 'prunedThrough'])
      .where('ownerId', '=', ownerId)
      .executeTakeFirst();
    // Detect loss at the exact retention boundary, including before the nightly physical deletion.
    const { rows } = await sql<{
      position: string;
    }>`SELECT coalesce(max(position),0)::text AS position FROM connect_event WHERE "ownerId"=${ownerId}::uuid AND "occurredAt"<=${new Date(Date.now() - RETENTION_MS)}`.execute(
      db,
    );
    const floor =
      BigInt(rows[0].position) > BigInt(stream?.prunedThrough ?? '0')
        ? rows[0].position
        : (stream?.prunedThrough ?? '0');
    return { position: stream?.position ?? '0', floor };
  }

  private async saveCursor(db: Kysely<DB>, state: Omit<Insertable<ConnectEventCursorTable>, 'tokenHash'>) {
    const token = randomBytes(32).toString('base64url');
    await db
      .insertInto('connect_event_cursor')
      .values({ ...state, tokenHash: tokenHash(token) })
      .execute();
    return token;
  }

  async cleanup(): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_MS);
    for (;;) {
      const { rows } = await sql<{ count: number }>`WITH batch AS (
          SELECT "ownerId",position FROM connect_event WHERE "occurredAt"<=${cutoff} ORDER BY "occurredAt" LIMIT 10000 FOR UPDATE SKIP LOCKED
        ), deleted AS (
          DELETE FROM connect_event event USING batch WHERE event."ownerId"=batch."ownerId" AND event.position=batch.position RETURNING event."ownerId",event.position
        ), watermark AS (
          UPDATE connect_event_stream stream SET "prunedThrough"=greatest(stream."prunedThrough",removed.position)
          FROM (SELECT "ownerId",max(position) AS position FROM deleted GROUP BY "ownerId") removed
          WHERE stream."ownerId"=removed."ownerId" RETURNING stream."ownerId"
        ) SELECT count(*)::int AS count FROM deleted`.execute(this.db);
      if (rows[0].count < 10_000) break;
    }
    await this.db.deleteFrom('connect_event_cursor').where('expiresAt', '<=', new Date()).execute();
  }
}
