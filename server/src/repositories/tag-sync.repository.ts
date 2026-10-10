import { ForbiddenException } from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { chunk } from 'lodash-es';
import { createHash } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { PinnedCollectionsResponseDto } from 'src/dtos/pinned-collection.dto.js';
import type { SyncAck } from 'src/types.js';
import { mapAlbumSourceLink } from 'src/dtos/album-source.dto.js';
import { mapPet, mapPetObservation } from 'src/dtos/pet.dto.js';
import { AlbumKind, AlbumUserRole, SyncEntityType } from 'src/enum.js';
import { AlbumSourceRepository } from 'src/repositories/album-source.repository.js';
import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
import { DuplicateRepository } from 'src/repositories/duplicate.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PetRepository } from 'src/repositories/pet.repository.js';
import { TrashRepository } from 'src/repositories/trash.repository.js';
import { DB } from 'src/schema/index.js';
import {
  getHiddenContentFilter,
  memoryHasNoHiddenItem,
  tagHasVisibleAssetOrNoAssets,
  tagIsSuppressed,
  withHiddenContentFilter,
} from 'src/utils/database.js';
import { getHiddenContentQueryOptions, getRevealQueryOptions } from 'src/utils/hidden-content.js';
import { getLockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { getLockedOwnerId, notLockedOrOwnedBy } from 'src/utils/locked.js';
import { toAck } from 'src/utils/sync.js';

export const MEMORY_SYNC_ACK_VERSION = 'memory-journal-v1';
export const MEMORY_SYNC_TYPES = [
  SyncEntityType.MemoryV1,
  SyncEntityType.MemoryDeleteV1,
  SyncEntityType.MemoryToAssetV1,
  SyncEntityType.MemoryToAssetDeleteV1,
];

type Kind =
  | 'memory'
  | 'memoryAsset'
  | 'tag'
  | 'assetTag'
  | 'pet'
  | 'petObservation'
  | 'space'
  | 'spaceMember'
  | 'duplicate'
  | 'pin'
  | 'trash'
  | 'spaceAlbum'
  | 'spacePerson'
  | 'albumAsset'
  | 'partnerAsset'
  | 'albumSourceLink';
type ReadPins = () => Promise<PinnedCollectionsResponseDto>;
const orderedKinds = new Set<Kind>([
  'memory',
  'memoryAsset',
  'tag',
  'assetTag',
  'pet',
  'petObservation',
  'spaceMember',
  'space',
  'duplicate',
  'pin',
  'trash',
  'spaceAlbum',
  'spacePerson',
  'albumAsset',
  'partnerAsset',
  'albumSourceLink',
]);
export type SharedAssetReader = (
  db: Kysely<DB>,
  auth: AuthDto,
  kind: 'albumAsset' | 'partnerAsset',
  key?: string,
) => Promise<Visible[]>;
type Visible = {
  key: string;
  entityId: string;
  assetId: string | null;
  sourceId: string;
  data: Record<string, unknown>;
};
const sequenced = (kind: Kind) =>
  ['space', 'spaceAlbum', 'spacePerson', 'tag', 'assetTag', 'pet', 'petObservation', 'spaceMember'].includes(kind);
const types = {
  memory: { upsert: SyncEntityType.MemoryV1, delete: SyncEntityType.MemoryDeleteV1 },
  memoryAsset: { upsert: SyncEntityType.MemoryToAssetV1, delete: SyncEntityType.MemoryToAssetDeleteV1 },
  albumAsset: { upsert: SyncEntityType.AlbumAssetAccessV1, delete: SyncEntityType.AlbumAssetAccessDeleteV1 },
  partnerAsset: { upsert: SyncEntityType.PartnerAssetAccessV1, delete: SyncEntityType.PartnerAssetAccessDeleteV1 },
  pin: { upsert: SyncEntityType.PinnedCollectionV1, delete: SyncEntityType.PinnedCollectionDeleteV1 },
  trash: { upsert: SyncEntityType.AssetTrashStateV1, delete: SyncEntityType.AssetTrashStateDeleteV1 },
  duplicate: { upsert: SyncEntityType.DuplicateGroupV1, delete: SyncEntityType.DuplicateGroupDeleteV1 },
  spaceAlbum: { upsert: SyncEntityType.SharedSpaceAlbumV1, delete: SyncEntityType.SharedSpaceAlbumDeleteV1 },
  spacePerson: { upsert: SyncEntityType.SharedSpacePersonV1, delete: SyncEntityType.SharedSpacePersonDeleteV1 },
  space: { upsert: SyncEntityType.SharedSpaceV1, delete: SyncEntityType.SharedSpaceDeleteV1 },
  spaceMember: { upsert: SyncEntityType.SharedSpaceMemberV1, delete: SyncEntityType.SharedSpaceMemberDeleteV1 },
  tag: { upsert: SyncEntityType.TagV1, delete: SyncEntityType.TagDeleteV1 },
  assetTag: { upsert: SyncEntityType.AssetTagV1, delete: SyncEntityType.AssetTagDeleteV1 },
  pet: { upsert: SyncEntityType.PetV1, delete: SyncEntityType.PetDeleteV1 },
  petObservation: { upsert: SyncEntityType.PetObservationV1, delete: SyncEntityType.PetObservationDeleteV1 },
  albumSourceLink: { upsert: SyncEntityType.AlbumSourceLinkV1, delete: SyncEntityType.AlbumSourceLinkDeleteV1 },
} as const;
/** Session delivery generations keep visibility revocations and regrants replay-safe. */
export class TagSync {
  constructor(
    private db: Kysely<DB>,
    private readSharedAssets?: SharedAssetReader,
  ) {}
  private async locked<T>(sessionId: string, run: (tx: Transaction<DB>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`tag-sync:${sessionId}`}, 0))`.execute(tx);
      return run(tx);
    });
  }
  private async visible(
    db: Kysely<DB>,
    kind: Kind,
    auth: AuthDto,
    key?: string,
    readPins?: ReadPins,
  ): Promise<Visible[]> {
    const options = getHiddenContentQueryOptions(auth);
    if (kind === 'memory' || kind === 'memoryAsset') {
      if (auth.sharedLink) return [];
      const memories = db
        .selectFrom('memory')
        .where('memory.ownerId', '=', auth.user.id)
        .where(memoryHasNoHiddenItem(sql.ref('memory.id'), options));
      if (kind === 'memory') {
        const rows = await memories
          .selectAll('memory')
          .$if(!!key, (qb) => qb.where('memory.id', '=', key!))
          .execute();
        return rows.map(({ updateId, ...data }) => ({
          key: data.id,
          entityId: data.id,
          assetId: null,
          sourceId: updateId,
          data,
        }));
      }
      const rows = await memories
        .innerJoin('memory_asset', 'memory_asset.memoriesId', 'memory.id')
        .select(['memory.id as memoryId', 'memory_asset.assetId', 'memory_asset.updateId'])
        .$if(!!key, (qb) =>
          qb.where('memory.id', '=', key!.split(':', 2)[0]).where('memory_asset.assetId', '=', key!.split(':', 2)[1]),
        )
        .execute();
      return rows.map(({ memoryId, assetId, updateId }) => ({
        key: `${memoryId}:${assetId}`,
        entityId: memoryId,
        assetId,
        sourceId: updateId,
        data: { memoryId, assetId },
      }));
    }
    if (kind === 'albumAsset' || kind === 'partnerAsset') {
      if (auth.sharedLink) return [];
      if (!this.readSharedAssets) throw new Error('Shared asset sync requires current authorized projection');
      const rows = await this.readSharedAssets(db, auth, kind, key);
      return rows.map((row) => {
        const digest = createHash('sha256').update(JSON.stringify(row.data)).digest('hex').slice(0, 32);
        return {
          ...row,
          sourceId: `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`,
        };
      });
    }
    if (kind === 'pin') {
      if (auth.sharedLink) throw new ForbiddenException('Pinned collections require a user session');
      if (!readPins) throw new Error('Pin sync requires current authorized hydration');
      const { pins } = await readPins();
      return pins.flatMap((pin, position) => {
        if (pin.unavailable || pin.targetId === null || (key && pin.id !== key)) return [];
        const { id, kind, targetId, title, count, countCapped, coverAssetId } = pin;
        const data = { id, kind, targetId, title, count, countCapped, coverAssetId, unavailable: false, position };
        const digest = createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 32);
        const sourceId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
        return [{ key: id, entityId: id, assetId: null, sourceId, data }];
      });
    }
    if (kind === 'trash') {
      if (auth.sharedLink) return [];
      const rows = await new TrashRepository(db).getSyncStates(
        auth.user.id,
        {
          ...getLockedVisibilityOptions(auth),
          privacy: options,
        },
        key,
      );
      return rows.map(({ assetId, data }) => {
        const digest = createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 32);
        const sourceId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
        return { key: assetId, entityId: assetId, assetId, sourceId, data: { ...data } };
      });
    }
    if (kind === 'duplicate') {
      if (auth.sharedLink) return [];
      const groups = await new DuplicateRepository(db).getSyncGroups(
        auth.user.id,
        { ...options, ...getRevealQueryOptions(auth) },
        key,
      );
      return groups.map((data) => {
        const digest = createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 32);
        const sourceId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
        return { key: data.groupId, entityId: data.groupId, assetId: null, sourceId, data: { ...data } };
      });
    }
    if (['space', 'spaceMember', 'spaceAlbum', 'spacePerson'].includes(kind)) {
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
      if (kind === 'spaceAlbum' || kind === 'spacePerson') {
        const eligible = await spaces.select('album.id').execute();
        const links = new AlbumUserRepository(db);
        const result: Visible[] = [];
        for (const { id: spaceId } of eligible) {
          if (kind === 'spaceAlbum') {
            const rows = (await links.getLinkedAlbums(spaceId, true)).filter(
              (row) => !key || `${spaceId}:${row.linkedAlbumId}` === key,
            );
            const initialIds = new Set(rows.map((row) => row.linkedAlbumId));
            const current = (await links.getLinkedAlbums(spaceId, true)).filter((row) =>
              initialIds.has(row.linkedAlbumId),
            );
            // The strict count and thumbnail query follows link revalidation; neither uses cached media.
            const counts = new Map(
              (
                await links.getLinkedAlbumCounts(
                  spaceId,
                  current.map((row) => row.linkedAlbumId),
                  { excludeNsfw: true },
                )
              ).map((row) => [row.albumId, row]),
            );
            for (const row of current) {
              const count = counts.get(row.linkedAlbumId);
              const data = {
                spaceId,
                albumId: row.linkedAlbumId,
                name: row.linkedAlbumName,
                icon: row.linkedAlbumIcon,
                assetCount: count?.assetCount ?? 0,
                thumbnailAssetId: count?.thumbnailAssetId ?? null,
                linkedAt: row.createdAt.toISOString(),
              };
              const digest = createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 32);
              const sourceId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
              result.push({ key: `${spaceId}:${row.linkedAlbumId}`, entityId: spaceId, assetId: null, sourceId, data });
            }
          } else {
            const rows = (await links.getLinkedPeople(spaceId, true)).filter((row) => !key || row.id === key);
            const counts = new Map(
              (
                await links.getLinkedPersonCounts(
                  spaceId,
                  rows.map((row) => row.personGroupId),
                  { excludeNsfw: true },
                )
              ).map((row) => [row.personGroupId, row.assetCount]),
            );
            // Counts are a separate query. Recheck the published identity and cover afterwards.
            const initialIds = new Set(rows.map((row) => row.id));
            const current = (await links.getLinkedPeople(spaceId, true)).filter((row) => initialIds.has(row.id));
            for (const row of current) {
              const data = {
                id: row.id,
                spaceId,
                name: row.name,
                coverAssetId: row.coverAssetId,
                assetCount: counts.get(row.personGroupId) ?? 0,
                linkedAt: row.createdAt.toISOString(),
              };
              const digest = createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 32);
              const sourceId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
              result.push({ key: row.id, entityId: spaceId, assetId: null, sourceId, data });
            }
          }
        }
        // Hydration has multiple queries; a previously accepted space is not a cached grant.
        const authorized = new Set((await spaces.select('album.id').execute()).map((row) => row.id));
        return result.filter((row) => authorized.has(row.entityId));
      }
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
    if (kind === 'albumSourceLink') {
      // FL-331: every device of the account sees every link whose album is live; links are the owner's own.
      if (auth.sharedLink) return [];
      const links = await new AlbumSourceRepository(db).getAll(db, auth.user.id);
      return links
        .filter((link) => !key || link.id === key)
        .map((link) => {
          const { albumName: _albumName, ...data } = mapAlbumSourceLink(link);
          const digest = createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 32);
          const sourceId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
          return { key: link.id, entityId: link.id, assetId: null, sourceId, data: { ...data } };
        });
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
  async reconcile(auth: AuthDto, kind: Kind, readPins?: ReadPins) {
    const sessionId = auth.session!.id;
    return this.locked(sessionId, async (tx) => {
      const visibleRows = await this.visible(tx, kind, auth, undefined, readPins);
      const rank = new Map(visibleRows.map((row, index) => [row.key, index]));
      const visible = new Map(visibleRows.map((row) => [row.key, row]));
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
              .$if(orderedKinds.has(kind), (qb) => qb.set({ deliveryOrder: null }))
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
              .$if(orderedKinds.has(kind), (qb) => qb.set({ deliveryOrder: null }))
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
      const pending = await tx
        .selectFrom('session_tag_sync_state')
        .selectAll()
        .where('sessionId', '=', sessionId)
        .where('kind', '=', kind)
        .where('acknowledged', '=', false)
        // Delivery ACKs never confirm unsent rows, so ordering identity independently cannot skip older entries.
        .$if(sequenced(kind), (qb) =>
          qb
            .orderBy(sql`"deliveryOrder" asc nulls last`)
            .orderBy(
              kind === 'spaceAlbum'
                ? sql`(select link."createdAt" from shared_space_album link where link."albumId"::text || ':' || link."linkedAlbumId"::text = session_tag_sync_state.key) desc nulls last`
                : kind === 'spacePerson'
                  ? sql`(select link."createdAt" from shared_space_person link where link.id::text = session_tag_sync_state.key) desc nulls last`
                  : kind === 'tag'
                    ? sql`(select tag."createdAt" from tag where tag.id = session_tag_sync_state."entityId") desc nulls last`
                    : kind === 'assetTag'
                      ? // Associations have no creation timestamp; their persisted v7 source ID is chronological.
                        sql`(select tag_asset."updateId" from tag_asset where tag_asset."tagId" = session_tag_sync_state."entityId" and tag_asset."assetId" = session_tag_sync_state."assetId") desc nulls last`
                      : kind === 'pet'
                        ? sql`(select pet."createdAt" from pet where pet.id = session_tag_sync_state."entityId") desc nulls last`
                        : kind === 'petObservation'
                          ? sql`(select pet_observation."createdAt" from pet_observation where pet_observation.id = session_tag_sync_state.key::uuid) desc nulls last`
                          : kind === 'spaceMember'
                            ? sql`(select album_user."createdAt" from album_user where album_user."albumId" = session_tag_sync_state."entityId" and album_user."userId" = split_part(session_tag_sync_state.key, ':', 2)::uuid) desc nulls last`
                            : sql`(select album."createdAt" from album where album.id = session_tag_sync_state."entityId") desc nulls last`,
            )
            .orderBy('key', 'desc'),
        )
        .orderBy('eventId', 'asc')
        .execute();
      if (['duplicate', 'pin', 'trash', 'albumAsset', 'partnerAsset'].includes(kind)) {
        pending.sort((a, b) => {
          if (a.deliveryOrder !== null || b.deliveryOrder !== null)
            return (a.deliveryOrder ?? Infinity) - (b.deliveryOrder ?? Infinity);
          return (rank.get(a.key) ?? Infinity) - (rank.get(b.key) ?? Infinity) || b.entityId.localeCompare(a.entityId);
        });
      }
      return pending;
    });
  }
  async prepare(auth: AuthDto, kind: Kind, eventId: string, readPins?: ReadPins) {
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
      const current = (await this.visible(tx, kind, auth, state.key, readPins)).find((row) => row.key === state.key);
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
        .$if(orderedKinds.has(kind) && state.deliveryOrder === null, (qb) =>
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
            : kind === 'memory'
              ? { memoryId: state.entityId }
              : kind === 'memoryAsset'
                ? { memoryId: state.entityId, assetId: state.assetId! }
                : kind === 'albumAsset'
                  ? { albumId: state.entityId, assetId: state.assetId! }
                  : kind === 'partnerAsset'
                    ? { sharedById: state.entityId, assetId: state.assetId! }
                    : kind === 'pin'
                      ? { pinId: state.entityId }
                      : kind === 'trash'
                        ? { assetId: state.entityId }
                        : kind === 'duplicate'
                          ? { groupId: state.entityId }
                          : kind === 'spaceAlbum'
                            ? { spaceId: state.entityId, albumId: state.key.split(':', 2)[1] }
                            : kind === 'spacePerson'
                              ? { spaceId: state.entityId, id: state.key }
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
                                        : kind === 'albumSourceLink'
                                          ? { linkId: state.entityId }
                                          : {
                                              observationId: state.key,
                                              petId: state.entityId,
                                              assetId: state.assetId!,
                                            },
      };
    });
  }
  async acknowledge(sessionId: string, ack: SyncAck): Promise<boolean> {
    const kind = Object.keys(types).find((k) =>
      (Object.values(types[k as Kind]) as SyncEntityType[]).includes(ack.type),
    ) as Kind | undefined;
    if (!kind) return false;
    // Old in-flight cursors cannot re-establish a legacy memory checkpoint after reset.
    if (MEMORY_SYNC_TYPES.includes(ack.type) && ack.extraId !== MEMORY_SYNC_ACK_VERSION) return true;
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
      if (!exact || (orderedKinds.has(kind) && exact.deliveryOrder === null)) return;
      const pending = tx
        .selectFrom('session_tag_sync_state')
        .select('key')
        .where('sessionId', '=', sessionId)
        .where('kind', '=', kind)
        .$if(orderedKinds.has(kind), (qb) => qb.where('deliveryOrder', '<=', exact.deliveryOrder!))
        .$if(!orderedKinds.has(kind), (qb) => qb.where('eventId', '<=', ack.updateId))
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
    const { rows } = await sql<{
      table: string | null;
    }>`select to_regclass('public.tag_audit')::text as table`.execute(this.db);
    if (!rows[0]?.table) return;
    await this.db.transaction().execute(async (tx) => {
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
