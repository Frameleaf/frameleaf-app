import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Insertable } from 'kysely';
import { DateTime, Duration } from 'luxon';
import { Writable } from 'node:stream';
import { z } from 'zod';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { SyncAck } from 'src/types.js';
import { OnJob } from 'src/decorators.js';
import { SyncAckDeleteDto, SyncAckSetDto, SyncItem, SyncStreamDto, syncAlbumV2ToV1 } from 'src/dtos/sync.dto.js';
import { JobName, QueueName, SyncEntityType, SyncRequestType, UserMetadataKey } from 'src/enum.js';
import { SyncQueryOptions } from 'src/repositories/sync.repository.js';
import { MEMORY_SYNC_ACK_VERSION, MEMORY_SYNC_TYPES } from 'src/repositories/tag-sync.repository.js';
import { SessionSyncCheckpointTable } from 'src/schema/tables/sync-checkpoint.table.js';
import { BaseService } from 'src/services/base.service.js';
import { PinnedCollectionService } from 'src/services/pinned-collection.service.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';

import { withoutStoredLockedRuleIds } from 'src/utils/preferences.js';
import { ClientDisconnectedError, waitForDrain } from 'src/utils/response.js';
import { SerializeOptions, fromAck, mapSyncAssetV2, serialize, toAck } from 'src/utils/sync.js';

const parseAssetBootstrapAck = (ack: string, type = SyncEntityType.AssetBootstrapV1) => {
  const parts = ack.split('|');
  const invalid = () => {
    throw new BadRequestException('Invalid asset bootstrap cursor');
  };
  if (parts.length !== 3 || parts[0] !== type || !z.uuid().safeParse(parts[1]).success) return invalid();
  if (parts[2] === COMPLETE_ID) return {};
  const encoded = parts[2]!;
  if (encoded.length > 256 || !/^[A-Za-z0-9_-]+$/.test(encoded)) return invalid();
  try {
    const text = Buffer.from(encoded, 'base64url').toString('utf8');
    if (Buffer.from(text).toString('base64url') !== encoded) return invalid();
    const value: unknown = JSON.parse(text);
    const result = z.tuple([z.string(), z.uuid()]).safeParse(value);
    if (!result.success) return invalid();
    const [timestamp, id] = result.data;
    if (
      timestamp !== '-infinity' &&
      (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(timestamp) ||
        Number(timestamp.slice(0, 4)) === 0 ||
        !DateTime.fromISO(timestamp, { zone: 'utc' }).isValid)
    )
      return invalid();
    return { cursor: { timestamp, id } };
  } catch {
    return invalid();
  }
};

const validateAlbumProgressAck = (type: SyncEntityType, ack: string) => {
  if (type !== SyncEntityType.AlbumV3 && type !== SyncEntityType.AlbumDeleteV2) return;
  const parts = ack.split('|');
  const length = type === SyncEntityType.AlbumV3 ? 3 : 2;
  if (parts.length !== length || parts[0] !== type || parts.slice(1).some((id) => !z.uuid().safeParse(id).success)) {
    throw new BadRequestException('Invalid album sync acknowledgement');
  }
};

type CheckpointMap = Partial<Record<SyncEntityType, SyncAck>>;
const COMPLETE_ID = 'complete';
const MAX_DAYS = 30;
const MAX_DURATION = Duration.fromObject({ days: MAX_DAYS });

const isEntityBackfillComplete = (createId: string, checkpoint: SyncAck | undefined): boolean =>
  createId === checkpoint?.updateId && checkpoint.extraId === COMPLETE_ID;

const getStartId = (createId: string, checkpoint: SyncAck | undefined): string | undefined =>
  createId === checkpoint?.updateId ? checkpoint?.extraId : undefined;

export const send = async <T extends keyof SyncItem, D extends SyncItem[T]>(
  response: Writable,
  item: SerializeOptions<T, D>,
) => {
  if (response.destroyed || response.writableEnded) {
    throw new ClientDisconnectedError();
  }

  // indicates back pressure, so we wait for 'drain' event
  if (!response.write(serialize(item))) {
    await waitForDrain(response);
  }
};

const sendEntityBackfillCompleteAck = async (response: Writable, ackType: SyncEntityType, id: string) => {
  await send(response, { type: SyncEntityType.SyncAckV1, data: {}, ackType, ids: [id, COMPLETE_ID] });
};

export const SYNC_TYPES_ORDER = [
  SyncRequestType.AlbumAssetAccessV1,
  SyncRequestType.PartnerAssetAccessV1,
  SyncRequestType.PinnedCollectionEventsV1,
  SyncRequestType.AssetTrashStatesV1,
  SyncRequestType.DuplicateGroupsV1,
  SyncRequestType.SharedSpacesV1,
  SyncRequestType.SharedSpaceMembersV1,
  SyncRequestType.SharedSpaceAlbumsV1,
  SyncRequestType.SharedSpacePeopleV1,
  SyncRequestType.PetsV1,
  SyncRequestType.PetObservationsV1,
  SyncRequestType.TagsV1,
  SyncRequestType.AssetTagsV1,
  SyncRequestType.AuthUsersV1,
  SyncRequestType.AuthUsersV2,
  SyncRequestType.UsersV1,
  SyncRequestType.PartnersV1,
  SyncRequestType.AssetsV1,
  SyncRequestType.AssetsV2,
  SyncRequestType.AssetsV3,
  SyncRequestType.StacksV1,
  SyncRequestType.PartnerAssetsV1,
  SyncRequestType.PartnerAssetsV2,
  SyncRequestType.PartnerStacksV1,
  SyncRequestType.AlbumAssetsV1,
  SyncRequestType.AlbumAssetsV2,
  SyncRequestType.AlbumsV1,
  SyncRequestType.AlbumsV2,
  SyncRequestType.AlbumsV3,
  SyncRequestType.AlbumUsersV1,
  SyncRequestType.AlbumToAssetsV1,
  SyncRequestType.AlbumSourceLinksV1,
  SyncRequestType.AssetExifsV1,
  SyncRequestType.AlbumAssetExifsV1,
  SyncRequestType.AssetOcrV1,
  SyncRequestType.PartnerAssetExifsV1,
  SyncRequestType.MemoriesV1,
  SyncRequestType.MemoryToAssetsV1,
  SyncRequestType.PeopleV1,
  SyncRequestType.AssetFacesV1,
  SyncRequestType.AssetFacesV2,
  SyncRequestType.AssetFacesV3,
  SyncRequestType.UserMetadataV1,
  SyncRequestType.PinnedCollectionsV1,
  SyncRequestType.AssetMetadataV1,
  SyncRequestType.AssetEditsV1,
];

const throwSessionRequired = () => {
  throw new ForbiddenException('Sync endpoints cannot be used with API keys');
};

@Injectable()
export class SyncService extends BaseService {
  @Inject(PinnedCollectionService)
  private pins!: PinnedCollectionService;

  getAcks(auth: AuthDto) {
    const sessionId = auth.session?.id;
    if (!sessionId) {
      return throwSessionRequired();
    }

    return this.syncCheckpointRepository.getAll(sessionId);
  }

  async setAcks(auth: AuthDto, dto: SyncAckSetDto) {
    const sessionId = auth.session?.id;
    if (!sessionId) {
      return throwSessionRequired();
    }

    const checkpoints: Record<string, Insertable<SessionSyncCheckpointTable>> = {};
    for (const ack of dto.acks) {
      const { type } = fromAck(ack);
      if (type === SyncEntityType.SyncResetV1) {
        await this.syncRepository.tag.reset(sessionId);
        await this.sessionRepository.resetSyncProgress(sessionId);
        return;
      }
      // TODO proper ack validation via class validator
      if (!Object.values(SyncEntityType).includes(type)) {
        throw new BadRequestException(`Invalid ack type: ${type}`);
      }

      if (type === SyncEntityType.AssetBootstrapV1 || type === SyncEntityType.AlbumBootstrapV1) {
        parseAssetBootstrapAck(ack, type);
      }

      validateAlbumProgressAck(type, ack);

      // TODO pick the latest ack for each type, instead of using the last one
      if (
        [
          ...MEMORY_SYNC_TYPES,
          SyncEntityType.AlbumAssetAccessV1,
          SyncEntityType.AlbumAssetAccessDeleteV1,
          SyncEntityType.PartnerAssetAccessV1,
          SyncEntityType.PartnerAssetAccessDeleteV1,
          SyncEntityType.PinnedCollectionV1,
          SyncEntityType.PinnedCollectionDeleteV1,
          SyncEntityType.AssetTrashStateV1,
          SyncEntityType.AssetTrashStateDeleteV1,
          SyncEntityType.DuplicateGroupV1,
          SyncEntityType.DuplicateGroupDeleteV1,
          SyncEntityType.SharedSpaceV1,
          SyncEntityType.SharedSpaceDeleteV1,
          SyncEntityType.SharedSpaceMemberV1,
          SyncEntityType.SharedSpaceMemberDeleteV1,
          SyncEntityType.SharedSpaceAlbumV1,
          SyncEntityType.SharedSpaceAlbumDeleteV1,
          SyncEntityType.SharedSpacePersonV1,
          SyncEntityType.SharedSpacePersonDeleteV1,
          SyncEntityType.PetV1,
          SyncEntityType.PetDeleteV1,
          SyncEntityType.AlbumSourceLinkV1,
          SyncEntityType.AlbumSourceLinkDeleteV1,
          SyncEntityType.PetObservationV1,
          SyncEntityType.PetObservationDeleteV1,
          SyncEntityType.TagV1,
          SyncEntityType.TagDeleteV1,
          SyncEntityType.AssetTagV1,
          SyncEntityType.AssetTagDeleteV1,
        ].includes(type) &&
        (await this.syncRepository.tag.acknowledge(sessionId, fromAck(ack)))
      ) {
        continue;
      }
      checkpoints[type] = { sessionId, type, ack };
    }

    if (Object.keys(checkpoints).length > 0) {
      await this.syncCheckpointRepository.upsertAll(Object.values(checkpoints));
    }
  }

  async deleteAcks(auth: AuthDto, dto: SyncAckDeleteDto) {
    const sessionId = auth.session?.id;
    if (!sessionId) {
      return throwSessionRequired();
    }

    await this.syncRepository.tag.reset(sessionId, dto.types);
    await this.syncCheckpointRepository.deleteAll(sessionId, dto.types);
  }

  async stream(auth: AuthDto, response: Writable, dto: SyncStreamDto) {
    try {
      await this.streamInternal(auth, response, dto);
    } catch (error) {
      if (error instanceof ClientDisconnectedError) {
        this.logger.debug('Client closed the connection');
        return;
      }

      throw error;
    }
  }

  private async streamInternal(auth: AuthDto, response: Writable, dto: SyncStreamDto) {
    const session = auth.session;
    if (!session) {
      return throwSessionRequired();
    }

    if (dto.reset) {
      await this.syncRepository.tag.reset(session.id);
      await this.sessionRepository.resetSyncProgress(session.id);
    }

    const isPendingSyncReset = await this.sessionRepository.isPendingSyncReset(session.id);
    if (isPendingSyncReset) {
      await send(response, { type: SyncEntityType.SyncResetV1, ids: ['reset'], data: {} });
      response.end();
      return;
    }

    const checkpoints = await this.syncCheckpointRepository.getAll(session.id);
    for (const { type, ack } of checkpoints) {
      validateAlbumProgressAck(type, ack);
      if (type === SyncEntityType.AssetBootstrapV1 || type === SyncEntityType.AlbumBootstrapV1)
        parseAssetBootstrapAck(ack, type);
    }
    const checkpointMap: CheckpointMap = Object.fromEntries(checkpoints.map(({ type, ack }) => [type, fromAck(ack)]));

    // Legacy memory cursors have no session visibility history. Reset the mirror once so previously
    // leaked/hidden memories are purged and every currently authorized row is backfilled.
    const hasLegacyMemoryCursor = MEMORY_SYNC_TYPES.some(
      (type) => checkpointMap[type] && checkpointMap[type].extraId !== MEMORY_SYNC_ACK_VERSION,
    );
    if (hasLegacyMemoryCursor || this.needsFullSync(checkpointMap)) {
      await send(response, { type: SyncEntityType.SyncResetV1, ids: ['reset'], data: {} });
      response.end();
      return;
    }

    const { nowId } = await this.syncCheckpointRepository.getNow();
    const options: SyncQueryOptions = { nowId, userId: auth.user.id, ...getHiddenContentQueryOptions(auth) };

    const handlers: Record<SyncRequestType, () => Promise<void>> = {
      [SyncRequestType.AlbumAssetAccessV1]: () => this.syncTags(auth, response, 'albumAsset'),
      // FL-326 (spec §4.8): partners receive their own copies through their own asset streams; the
      // partner asset streams stay for older clients and send nothing
      [SyncRequestType.PartnerAssetAccessV1]: () => Promise.resolve(),
      [SyncRequestType.PinnedCollectionEventsV1]: () => this.syncTags(auth, response, 'pin'),
      [SyncRequestType.AssetTrashStatesV1]: () => this.syncTags(auth, response, 'trash'),
      [SyncRequestType.DuplicateGroupsV1]: () => this.syncTags(auth, response, 'duplicate'),
      [SyncRequestType.SharedSpacesV1]: () => this.syncTags(auth, response, 'space'),
      [SyncRequestType.SharedSpaceMembersV1]: () => this.syncTags(auth, response, 'spaceMember'),
      [SyncRequestType.SharedSpaceAlbumsV1]: () => this.syncTags(auth, response, 'spaceAlbum'),
      [SyncRequestType.SharedSpacePeopleV1]: () => this.syncTags(auth, response, 'spacePerson'),
      [SyncRequestType.PetsV1]: () => this.syncTags(auth, response, 'pet'),
      [SyncRequestType.AlbumSourceLinksV1]: () => this.syncTags(auth, response, 'albumSourceLink'),
      [SyncRequestType.PetObservationsV1]: () => this.syncTags(auth, response, 'petObservation'),
      [SyncRequestType.TagsV1]: () => this.syncTags(auth, response, 'tag'),
      [SyncRequestType.AssetTagsV1]: () => this.syncTags(auth, response, 'assetTag'),
      // deprecated handlers
      [SyncRequestType.AssetsV1]: () => this.syncAssetsV1(),
      [SyncRequestType.AssetFacesV1]: () => this.syncAssetFacesV1(),
      [SyncRequestType.PartnerAssetsV1]: () => this.syncPartnerAssetsV1(),
      [SyncRequestType.AlbumAssetsV1]: () => this.syncAlbumAssetsV1(),

      [SyncRequestType.AuthUsersV1]: () => this.syncAuthUsersV1(options, response, checkpointMap),
      [SyncRequestType.AuthUsersV2]: () => this.syncAuthUsersV2(options, response, checkpointMap),
      [SyncRequestType.UsersV1]: () => this.syncUsersV1(options, response, checkpointMap),
      [SyncRequestType.PartnersV1]: () => this.syncPartnersV1(options, response, checkpointMap),
      [SyncRequestType.AssetsV2]: () => this.syncAssetsV2(options, response, checkpointMap),
      [SyncRequestType.AssetsV3]: () => this.syncAssetsV3(options, response, checkpointMap),
      [SyncRequestType.AssetExifsV1]: () => this.syncAssetExifsV1(options, response, checkpointMap),
      [SyncRequestType.AssetEditsV1]: () => this.syncAssetEditsV1(options, response, checkpointMap),
      [SyncRequestType.PartnerAssetsV2]: () => Promise.resolve(),
      [SyncRequestType.AssetMetadataV1]: () => this.syncAssetMetadataV1(options, response, checkpointMap, auth),
      [SyncRequestType.PartnerAssetExifsV1]: () => Promise.resolve(),
      [SyncRequestType.AlbumsV1]: () => this.syncAlbumsV1(options, response, checkpointMap),
      [SyncRequestType.AlbumsV2]: () => this.syncAlbumsV2(options, response, checkpointMap),
      [SyncRequestType.AlbumsV3]: () => this.syncAlbumsV3(options, response, checkpointMap),
      [SyncRequestType.AlbumUsersV1]: () => this.syncAlbumUsersV1(options, response, checkpointMap, session.id),
      [SyncRequestType.AlbumAssetsV2]: () => this.syncAlbumAssetsV2(options, response, checkpointMap, session.id),
      [SyncRequestType.AlbumToAssetsV1]: () => this.syncAlbumToAssetsV1(options, response, checkpointMap, session.id),
      [SyncRequestType.AlbumAssetExifsV1]: () =>
        this.syncAlbumAssetExifsV1(options, response, checkpointMap, session.id),
      [SyncRequestType.MemoriesV1]: () => this.syncTags(auth, response, 'memory'),
      [SyncRequestType.MemoryToAssetsV1]: () => this.syncTags(auth, response, 'memoryAsset'),
      [SyncRequestType.StacksV1]: () => this.syncStackV1(options, response, checkpointMap),
      [SyncRequestType.PartnerStacksV1]: () => Promise.resolve(),
      [SyncRequestType.PeopleV1]: () => this.syncPeopleV1(options, response, checkpointMap),
      [SyncRequestType.AssetFacesV2]: () => this.syncAssetFacesV2(options, response, checkpointMap),
      [SyncRequestType.AssetFacesV3]: () => this.syncAssetFacesV3(options, response, checkpointMap),
      [SyncRequestType.UserMetadataV1]: () => this.syncUserMetadataV1(options, response, checkpointMap, auth),
      // FL-232: each request replaces the entire mirror snapshot, even after an ack. Access can
      // change without the stored pin revision changing; old hydration must never remain cached.
      [SyncRequestType.PinnedCollectionsV1]: async () => {
        const snapshot = await this.pins.get(auth);
        await send(response, {
          type: SyncEntityType.PinnedCollectionsV1,
          ids: [nowId],
          data: { userId: auth.user.id, ...snapshot },
        });
      },
      [SyncRequestType.AssetOcrV1]: () => this.syncAssetOcrV1(options, response, checkpointMap, auth),
    } as const;

    for (const type of SYNC_TYPES_ORDER) {
      if (!dto.types.includes(type)) {
        continue;
      }

      const handler = handlers[type as keyof typeof handlers];
      await handler();
    }

    await send(response, { type: SyncEntityType.SyncCompleteV1, ids: [nowId], data: {} });

    response.end();
  }

  @OnJob({ name: JobName.AuditTableCleanup, queue: QueueName.BackgroundTask })
  async onAuditTableCleanup() {
    const pruneThreshold = MAX_DAYS + 1;
    await this.syncRepository.tag.cleanupAuditTables(pruneThreshold);

    await this.syncRepository.album.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.albumUser.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.albumToAsset.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.asset.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.assetFace.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.assetMetadata.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.assetEdit.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.memory.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.memoryToAsset.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.partner.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.person.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.personGroup.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.stack.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.user.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.userMetadata.cleanupAuditTable(pruneThreshold);
    await this.syncRepository.assetOcr.cleanupAuditTable(pruneThreshold);
  }

  private needsFullSync(checkpointMap: CheckpointMap) {
    const completeAck = checkpointMap[SyncEntityType.SyncCompleteV1];
    if (!completeAck) {
      return false;
    }

    const milliseconds = Number.parseInt(completeAck.updateId.replaceAll('-', '').slice(0, 12), 16);

    return DateTime.fromMillis(milliseconds) < DateTime.now().minus(MAX_DURATION);
  }

  private async syncAuthUsersV1(options: SyncQueryOptions, response: Writable, checkpointMap: CheckpointMap) {
    const upsertType = SyncEntityType.AuthUserV1;
    const upserts = this.syncRepository.authUser.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, profileImagePath, ...data } of upserts) {
      await send(response, {
        type: upsertType,
        ids: [updateId],
        data: { ...data, oauthId: data.oauthId ?? '', hasProfileImage: !!profileImagePath },
      });
    }
  }

  private async syncAuthUsersV2(options: SyncQueryOptions, response: Writable, checkpointMap: CheckpointMap) {
    const upsertType = SyncEntityType.AuthUserV2;
    const upserts = this.syncRepository.authUser.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, profileImagePath, ...data } of upserts) {
      await send(response, {
        type: upsertType,
        ids: [updateId],
        data: { ...data, hasProfileImage: !!profileImagePath },
      });
    }
  }

  private async syncUsersV1(options: SyncQueryOptions, response: Writable, checkpointMap: CheckpointMap) {
    const deleteType = SyncEntityType.UserDeleteV1;
    const deletes = this.syncRepository.user.getDeletes({ ...options, ack: checkpointMap[deleteType] });
    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }

    const upsertType = SyncEntityType.UserV1;
    const upserts = this.syncRepository.user.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, profileImagePath, ...data } of upserts) {
      await send(response, {
        type: upsertType,
        ids: [updateId],
        data: { ...data, hasProfileImage: !!profileImagePath },
      });
    }
  }

  private async syncPartnersV1(options: SyncQueryOptions, response: Writable, checkpointMap: CheckpointMap) {
    const deleteType = SyncEntityType.PartnerDeleteV1;
    const deletes = this.syncRepository.partner.getDeletes({ ...options, ack: checkpointMap[deleteType] });
    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }

    const upsertType = SyncEntityType.PartnerV1;
    const upserts = this.syncRepository.partner.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, ...data } of upserts) {
      await send(response, { type: upsertType, ids: [updateId], data });
    }
  }

  private syncAssetsV1(): Promise<void> {
    throw new BadRequestException('SyncRequestType.AssetsV1 is deprecated, use SyncRequestType.AssetsV2 instead');
  }

  private async syncAssetsV2(options: SyncQueryOptions, response: Writable, checkpointMap: CheckpointMap) {
    const deleteType = SyncEntityType.AssetDeleteV1;
    const deletes = this.syncRepository.asset.getDeletes({ ...options, ack: checkpointMap[deleteType] });
    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }

    const upsertType = SyncEntityType.AssetV2;
    const upserts = this.syncRepository.asset.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, ...data } of upserts) {
      await send(response, { type: upsertType, ids: [updateId], data: mapSyncAssetV2(data) });
    }
  }

  private async syncAssetsV3(options: SyncQueryOptions, response: Writable, checkpointMap: CheckpointMap) {
    const bootstrapType = SyncEntityType.AssetBootstrapV1;
    const checkpoint = checkpointMap[bootstrapType];
    const parsed = checkpoint && parseAssetBootstrapAck(toAck(checkpoint));
    const watermark = checkpoint?.updateId ?? options.nowId;
    if (checkpoint?.extraId !== COMPLETE_ID) {
      const assets = this.syncRepository.asset.getBootstrap({ ...options, nowId: watermark }, parsed?.cursor);
      for await (const { bootstrapTimestamp, ...data } of assets) {
        const cursor = Buffer.from(JSON.stringify([bootstrapTimestamp, data.id])).toString('base64url');
        await send(response, {
          type: SyncEntityType.AssetV3,
          ackType: bootstrapType,
          ids: [watermark, cursor],
          data: mapSyncAssetV2(data),
        });
      }
      await sendEntityBackfillCompleteAck(response, bootstrapType, watermark);
    }

    // The bootstrap floor is a fallback, never a separately emitted delta ack.
    const floor = { type: bootstrapType, updateId: watermark };
    const deleteType = SyncEntityType.AssetDeleteV2;
    for await (const { id, ...data } of this.syncRepository.asset.getDeletes({
      ...options,
      ack: checkpointMap[deleteType] ?? floor,
    })) {
      await send(response, { type: deleteType, ids: [id], data });
    }
    const upsertType = SyncEntityType.AssetV3;
    for await (const { updateId, ...data } of this.syncRepository.asset.getUpserts({
      ...options,
      ack: checkpointMap[upsertType] ?? floor,
    })) {
      await send(response, { type: upsertType, ids: [updateId], data: mapSyncAssetV2(data) });
    }
  }

  private syncPartnerAssetsV1(): Promise<void> {
    throw new BadRequestException(
      'SyncRequestType.PartnerAssetsV1 is deprecated, use SyncRequestType.PartnerAssetsV2 instead',
    );
  }

  private async syncAssetExifsV1(options: SyncQueryOptions, response: Writable, checkpointMap: CheckpointMap) {
    const upsertType = SyncEntityType.AssetExifV1;
    const upserts = this.syncRepository.assetExif.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, ...data } of upserts) {
      await send(response, { type: upsertType, ids: [updateId], data });
    }
  }

  private async syncAssetEditsV1(options: SyncQueryOptions, response: Writable, checkpointMap: CheckpointMap) {
    const deleteType = SyncEntityType.AssetEditDeleteV1;
    const deletes = this.syncRepository.assetEdit.getDeletes({ ...options, ack: checkpointMap[deleteType] });

    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }
    const upsertType = SyncEntityType.AssetEditV1;
    const upserts = this.syncRepository.assetEdit.getUpserts({ ...options, ack: checkpointMap[upsertType] });

    for await (const { updateId, ...data } of upserts) {
      await send(response, { type: upsertType, ids: [updateId], data });
    }
  }

  private async syncAlbumsV1(options: SyncQueryOptions, response: Writable, checkpointMap: CheckpointMap) {
    const deleteType = SyncEntityType.AlbumDeleteV1;
    const deletes = this.syncRepository.album.getDeletes({ ...options, ack: checkpointMap[deleteType] });
    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }

    const upsertType = SyncEntityType.AlbumV1;
    const upserts = this.syncRepository.album.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, ...data } of upserts) {
      const albumUsers = await this.syncRepository.album.getAlbumUsers(data.id);
      await send(response, {
        type: upsertType,
        ids: [updateId],
        // TODO: return null instead of '' in v4
        data: syncAlbumV2ToV1({ ...data, description: data.description ?? '' }, albumUsers),
      });
    }
  }

  private async syncAlbumsV2(options: SyncQueryOptions, response: Writable, checkpointMap: CheckpointMap) {
    const deleteType = SyncEntityType.AlbumDeleteV1;
    const deletes = this.syncRepository.album.getDeletes({ ...options, ack: checkpointMap[deleteType] });
    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }

    const upsertType = SyncEntityType.AlbumV2;
    const upserts = this.syncRepository.album.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, ...data } of upserts) {
      // TODO: return null instead of '' in v4
      await send(response, {
        type: upsertType,
        ids: [updateId],
        data: { ...data, description: data.description ?? '' },
      });
    }
  }

  private async syncAlbumsV3(options: SyncQueryOptions, response: Writable, checkpointMap: CheckpointMap) {
    const bootstrapType = SyncEntityType.AlbumBootstrapV1;
    const checkpoint = checkpointMap[bootstrapType];
    const watermark = checkpoint?.updateId ?? options.nowId;
    const parsed = checkpoint && parseAssetBootstrapAck(toAck(checkpoint), bootstrapType);
    if (checkpoint?.extraId !== COMPLETE_ID) {
      for await (const {
        bootstrapTimestamp,
        updateId: _eventId,
        ...data
      } of this.syncRepository.album.getTreeBootstrap({ ...options, nowId: watermark }, parsed?.cursor)) {
        const cursor = Buffer.from(JSON.stringify([bootstrapTimestamp, data.id])).toString('base64url');
        await send(response, {
          type: SyncEntityType.AlbumV3,
          ackType: bootstrapType,
          ids: [watermark, cursor],
          data: { ...data, description: data.description ?? '' },
        });
      }
      await sendEntityBackfillCompleteAck(response, bootstrapType, watermark);
    }
    const floor = { type: bootstrapType, updateId: watermark };
    const deleteType = SyncEntityType.AlbumDeleteV2;
    for await (const { id, ...data } of this.syncRepository.album.getDeletes({
      ...options,
      ack: checkpointMap[deleteType] ?? floor,
    })) {
      await send(response, { type: deleteType, ids: [id], data });
    }
    const upsertType = SyncEntityType.AlbumV3;
    for await (const { updateId, ...data } of this.syncRepository.album.getTreeUpserts({
      ...options,
      ack: checkpointMap[upsertType] ?? floor,
    })) {
      await send(response, {
        type: upsertType,
        ids: [updateId, data.id],
        data: { ...data, description: data.description ?? '' },
      });
    }
  }

  private async syncAlbumUsersV1(
    options: SyncQueryOptions,
    response: Writable,
    checkpointMap: CheckpointMap,
    sessionId: string,
  ) {
    const deleteType = SyncEntityType.AlbumUserDeleteV1;
    const deletes = this.syncRepository.albumUser.getDeletes({ ...options, ack: checkpointMap[deleteType] });
    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }

    const backfillType = SyncEntityType.AlbumUserBackfillV1;
    const backfillCheckpoint = checkpointMap[backfillType];
    const albums = await this.syncRepository.album.getCreatedAfter({
      ...options,
      afterCreateId: backfillCheckpoint?.updateId,
    });
    const upsertType = SyncEntityType.AlbumUserV1;
    const upsertCheckpoint = checkpointMap[upsertType];
    if (upsertCheckpoint) {
      const endId = upsertCheckpoint.updateId;

      for (const album of albums) {
        const createId = album.createId;
        if (isEntityBackfillComplete(createId, backfillCheckpoint)) {
          continue;
        }

        const startId = getStartId(createId, backfillCheckpoint);
        const backfill = this.syncRepository.albumUser.getBackfill(
          { ...options, afterUpdateId: startId, beforeUpdateId: endId },
          album.id,
        );

        for await (const { updateId, ...data } of backfill) {
          await send(response, { type: backfillType, ids: [createId, updateId], data });
        }

        await sendEntityBackfillCompleteAck(response, backfillType, createId);
      }
    } else if (albums.length > 0) {
      await this.upsertBackfillCheckpoint({
        type: backfillType,
        sessionId,
        createId: albums.at(-1)!.createId,
      });
    }

    const upserts = this.syncRepository.albumUser.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, ...data } of upserts) {
      await send(response, { type: upsertType, ids: [updateId], data });
    }
  }

  private syncAlbumAssetsV1(): Promise<void> {
    throw new BadRequestException(
      'SyncRequestType.AlbumAssetsV1 is deprecated, use SyncRequestType.AlbumAssetsV2 instead',
    );
  }

  private async syncAlbumAssetsV2(
    options: SyncQueryOptions,
    response: Writable,
    checkpointMap: CheckpointMap,
    sessionId: string,
  ) {
    const backfillType = SyncEntityType.AlbumAssetBackfillV2;
    const backfillCheckpoint = checkpointMap[backfillType];
    const albums = await this.syncRepository.album.getCreatedAfter({
      ...options,
      afterCreateId: backfillCheckpoint?.updateId,
    });
    const updateType = SyncEntityType.AlbumAssetUpdateV2;
    const createType = SyncEntityType.AlbumAssetCreateV2;
    const updateCheckpoint = checkpointMap[updateType];
    const createCheckpoint = checkpointMap[createType];
    if (createCheckpoint) {
      const endId = createCheckpoint.updateId;

      for (const album of albums) {
        const createId = album.createId;
        if (isEntityBackfillComplete(createId, backfillCheckpoint)) {
          continue;
        }

        const startId = getStartId(createId, backfillCheckpoint);
        const backfill = this.syncRepository.albumAsset.getBackfill(
          { ...options, afterUpdateId: startId, beforeUpdateId: endId },
          album.id,
          options.userId,
        );

        for await (const { updateId, ...data } of backfill) {
          await send(response, { type: backfillType, ids: [createId, updateId], data: mapSyncAssetV2(data) });
        }

        await sendEntityBackfillCompleteAck(response, backfillType, createId);
      }
    } else if (albums.length > 0) {
      await this.upsertBackfillCheckpoint({
        type: backfillType,
        sessionId,
        createId: albums.at(-1)!.createId,
      });
    }

    if (createCheckpoint) {
      const updates = this.syncRepository.albumAsset.getUpdates(
        { ...options, ack: updateCheckpoint },
        createCheckpoint,
      );
      for await (const { updateId, ...data } of updates) {
        await send(response, { type: updateType, ids: [updateId], data: mapSyncAssetV2(data) });
      }
    }

    const creates = this.syncRepository.albumAsset.getCreates({ ...options, ack: createCheckpoint });
    let isFirst = true;
    for await (const { updateId, ...data } of creates) {
      if (isFirst) {
        await send(response, {
          type: SyncEntityType.SyncAckV1,
          data: {},
          ackType: SyncEntityType.AlbumAssetUpdateV2,
          ids: [options.nowId],
        });
        isFirst = false;
      }
      await send(response, { type: createType, ids: [updateId], data: mapSyncAssetV2(data) });
    }
  }

  private async syncAlbumAssetExifsV1(
    options: SyncQueryOptions,
    response: Writable,
    checkpointMap: CheckpointMap,
    sessionId: string,
  ) {
    const backfillType = SyncEntityType.AlbumAssetExifBackfillV1;
    const backfillCheckpoint = checkpointMap[backfillType];
    const albums = await this.syncRepository.album.getCreatedAfter({
      ...options,
      afterCreateId: backfillCheckpoint?.updateId,
    });
    const updateType = SyncEntityType.AlbumAssetExifUpdateV1;
    const createType = SyncEntityType.AlbumAssetExifCreateV1;
    const upsertCheckpoint = checkpointMap[updateType];
    const createCheckpoint = checkpointMap[createType];
    if (createCheckpoint) {
      const endId = createCheckpoint.updateId;

      for (const album of albums) {
        const createId = album.createId;
        if (isEntityBackfillComplete(createId, backfillCheckpoint)) {
          continue;
        }

        const startId = getStartId(createId, backfillCheckpoint);
        const backfill = this.syncRepository.albumAssetExif.getBackfill(
          { ...options, afterUpdateId: startId, beforeUpdateId: endId },
          album.id,
          options.userId,
        );

        for await (const { updateId, ...data } of backfill) {
          await send(response, { type: backfillType, ids: [createId, updateId], data });
        }

        await sendEntityBackfillCompleteAck(response, backfillType, createId);
      }
    } else if (albums.length > 0) {
      await this.upsertBackfillCheckpoint({
        type: backfillType,
        sessionId,
        createId: albums.at(-1)!.createId,
      });
    }

    if (createCheckpoint) {
      const updates = this.syncRepository.albumAssetExif.getUpdates(
        { ...options, ack: upsertCheckpoint },
        createCheckpoint,
      );
      for await (const { updateId, ...data } of updates) {
        await send(response, { type: updateType, ids: [updateId], data });
      }
    }

    const creates = this.syncRepository.albumAssetExif.getCreates({ ...options, ack: createCheckpoint });
    let isFirst = true;
    for await (const { updateId, ...data } of creates) {
      if (isFirst) {
        await send(response, {
          type: SyncEntityType.SyncAckV1,
          data: {},
          ackType: SyncEntityType.AlbumAssetExifUpdateV1,
          ids: [options.nowId],
        });
        isFirst = false;
      }
      await send(response, { type: createType, ids: [updateId], data });
    }
  }

  private async syncAlbumToAssetsV1(
    options: SyncQueryOptions,
    response: Writable,
    checkpointMap: CheckpointMap,
    sessionId: string,
  ) {
    const deleteType = SyncEntityType.AlbumToAssetDeleteV1;
    const deletes = this.syncRepository.albumToAsset.getDeletes({ ...options, ack: checkpointMap[deleteType] });
    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }

    const backfillType = SyncEntityType.AlbumToAssetBackfillV1;
    const backfillCheckpoint = checkpointMap[backfillType];
    const albums = await this.syncRepository.album.getCreatedAfter({
      ...options,
      afterCreateId: backfillCheckpoint?.updateId,
    });
    const upsertType = SyncEntityType.AlbumToAssetV1;
    const upsertCheckpoint = checkpointMap[upsertType];
    if (upsertCheckpoint) {
      const endId = upsertCheckpoint.updateId;

      for (const album of albums) {
        const createId = album.createId;
        if (isEntityBackfillComplete(createId, backfillCheckpoint)) {
          continue;
        }

        const startId = getStartId(createId, backfillCheckpoint);
        const backfill = this.syncRepository.albumToAsset.getBackfill(
          { ...options, afterUpdateId: startId, beforeUpdateId: endId },
          album.id,
          options.userId,
        );

        for await (const { updateId, ...data } of backfill) {
          await send(response, { type: backfillType, ids: [createId, updateId], data });
        }

        await sendEntityBackfillCompleteAck(response, backfillType, createId);
      }
    } else if (albums.length > 0) {
      await this.upsertBackfillCheckpoint({
        type: backfillType,
        sessionId,
        createId: albums.at(-1)!.createId,
      });
    }

    const upserts = this.syncRepository.albumToAsset.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, ...data } of upserts) {
      await send(response, { type: upsertType, ids: [updateId], data });
    }
  }

  private async syncStackV1(options: SyncQueryOptions, response: Writable, checkpointMap: CheckpointMap) {
    const deleteType = SyncEntityType.StackDeleteV1;
    const deletes = this.syncRepository.stack.getDeletes({ ...options, ack: checkpointMap[deleteType] });
    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }

    const upsertType = SyncEntityType.StackV1;
    const upserts = this.syncRepository.stack.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, ...data } of upserts) {
      await send(response, { type: upsertType, ids: [updateId], data });
    }
  }

  private async syncTags(
    auth: AuthDto,
    response: Writable,
    kind:
      | 'memory'
      | 'memoryAsset'
      | 'tag'
      | 'assetTag'
      | 'pet'
      | 'petObservation'
      | 'albumSourceLink'
      | 'space'
      | 'spaceMember'
      | 'duplicate'
      | 'pin'
      | 'trash'
      | 'spaceAlbum'
      | 'spacePerson'
      | 'albumAsset'
      | 'partnerAsset',
  ) {
    const readPins = kind === 'pin' ? () => this.pins.get(auth) : undefined;
    const pending = await (readPins
      ? this.syncRepository.tag.reconcile(auth, kind, readPins)
      : this.syncRepository.tag.reconcile(auth, kind));
    for (const { eventId } of pending) {
      if (response.destroyed || response.writableEnded) throw new ClientDisconnectedError();
      const item = await (readPins
        ? this.syncRepository.tag.prepare(auth, kind, eventId, readPins)
        : this.syncRepository.tag.prepare(auth, kind, eventId));
      if (item)
        await send(response, {
          type: item.type,
          ids: kind === 'memory' || kind === 'memoryAsset' ? [item.eventId, MEMORY_SYNC_ACK_VERSION] : [item.eventId],
          data: item.data as never,
        });
    }
  }

  private async syncPeopleV1(options: SyncQueryOptions, response: Writable, checkpointMap: CheckpointMap) {
    const deleteType = SyncEntityType.PersonDeleteV1;
    const deletes = this.syncRepository.person.getDeletes({ ...options, ack: checkpointMap[deleteType] });
    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }

    const upsertType = SyncEntityType.PersonV1;
    const upserts = this.syncRepository.person.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, ...data } of upserts) {
      await send(response, { type: upsertType, ids: [updateId], data });
    }
  }

  private syncAssetFacesV1(): Promise<void> {
    throw new BadRequestException(
      'SyncRequestType.AssetFacesV1 is deprecated, use SyncRequestType.AssetFacesV2 instead',
    );
  }

  // TODO(v5) drop when AssetFacesV2 is removed
  private async syncAssetFacesV2(options: SyncQueryOptions, response: Writable, checkpointMap: CheckpointMap) {
    const deleteType = SyncEntityType.AssetFaceDeleteV1;
    const deletes = this.syncRepository.assetFace.getDeletesV2({ ...options, ack: checkpointMap[deleteType] });
    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }

    const upsertType = SyncEntityType.AssetFaceV2;
    const upserts = this.syncRepository.assetFace.getUpsertsV2({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, ...data } of upserts) {
      await send(response, { type: upsertType, ids: [updateId], data });
    }
  }

  private async syncAssetFacesV3(options: SyncQueryOptions, response: Writable, checkpointMap: CheckpointMap) {
    const deleteType = SyncEntityType.AssetFaceDeleteV1;
    const deletes = this.syncRepository.assetFace.getDeletesV3({ ...options, ack: checkpointMap[deleteType] });
    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }

    const upsertType = SyncEntityType.AssetFaceV3;
    const upserts = this.syncRepository.assetFace.getUpsertsV3({ ...options, ack: checkpointMap[upsertType] });
    for await (const { updateId, ...data } of upserts) {
      await send(response, { type: upsertType, ids: [updateId], data });
    }
  }

  /**
   * FL-67: the account's Locked people, pets and tags are left out of its preferences unless the
   * syncing session is unlocked, as `GET /users/me/preferences` does.
   */
  private async syncUserMetadataV1(
    options: SyncQueryOptions,
    response: Writable,
    checkpointMap: CheckpointMap,
    auth: AuthDto,
  ) {
    const deleteType = SyncEntityType.UserMetadataDeleteV1;
    const deletes = this.syncRepository.userMetadata.getDeletes({ ...options, ack: checkpointMap[deleteType] });

    for await (const { id, ...data } of deletes) {
      if (data.key === UserMetadataKey.PinnedCollections || data.key === UserMetadataKey.PhotographyWorkspace) {
        continue;
      }
      await send(response, { type: deleteType, ids: [id], data });
    }

    const upsertType = SyncEntityType.UserMetadataV1;
    const upserts = this.syncRepository.userMetadata.getUpserts({ ...options, ack: checkpointMap[upsertType] });
    const revealLockedRules = !!auth.session?.hasElevatedPermission;

    for await (const { updateId, ...data } of upserts) {
      if (data.key === UserMetadataKey.PinnedCollections || data.key === UserMetadataKey.PhotographyWorkspace) {
        continue;
      }
      const visible =
        data.key === UserMetadataKey.Preferences && !revealLockedRules
          ? { ...data, value: withoutStoredLockedRuleIds(data.value) }
          : data;
      await send(response, { type: upsertType, ids: [updateId], data: visible });
    }
  }

  private async syncAssetMetadataV1(
    options: SyncQueryOptions,
    response: Writable,
    checkpointMap: CheckpointMap,
    auth: AuthDto,
  ) {
    const deleteType = SyncEntityType.AssetMetadataDeleteV1;
    const deletes = this.syncRepository.assetMetadata.getDeletes(
      { ...options, ack: checkpointMap[deleteType] },
      auth.user.id,
    );

    for await (const { id, ...data } of deletes) {
      await send(response, { type: deleteType, ids: [id], data });
    }

    const upsertType = SyncEntityType.AssetMetadataV1;
    const upserts = this.syncRepository.assetMetadata.getUpserts(
      { ...options, ack: checkpointMap[upsertType] },
      auth.user.id,
    );

    for await (const { updateId, ...data } of upserts) {
      await send(response, { type: upsertType, ids: [updateId], data });
    }
  }

  private async syncAssetOcrV1(
    options: SyncQueryOptions,
    response: Writable,
    checkpointMap: CheckpointMap,
    auth: AuthDto,
  ) {
    const deleteType = SyncEntityType.AssetOcrDeleteV1;
    const deletes = this.syncRepository.assetOcr.getDeletes(
      { ...options, ack: checkpointMap[deleteType] },
      auth.user.id,
    );

    for await (const row of deletes) {
      await send(response, { type: deleteType, ids: [row.id], data: row });
    }

    const upsertType = SyncEntityType.AssetOcrV1;
    const upserts = this.syncRepository.assetOcr.getUpserts(
      { ...options, ack: checkpointMap[upsertType] },
      auth.user.id,
    );

    for await (const { updateId, ...data } of upserts) {
      await send(response, { type: upsertType, ids: [updateId], data });
    }
  }

  private async upsertBackfillCheckpoint(item: { type: SyncEntityType; sessionId: string; createId: string }) {
    const { type, sessionId, createId } = item;
    await this.syncCheckpointRepository.upsertAll([
      {
        type,
        sessionId,
        ack: toAck({
          type,
          updateId: createId,
          extraId: COMPLETE_ID,
        }),
      },
    ]);
  }
}
