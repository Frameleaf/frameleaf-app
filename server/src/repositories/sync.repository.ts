import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { SyncAck } from 'src/types.js';
import { EXTERNAL_SCAN_CHECKSUM } from 'src/constants.js';
import { columns } from 'src/database.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AlbumUserRole, AssetMetadataKey, ChecksumAlgorithm, UserMetadataKey } from 'src/enum.js';
import { TagSync } from 'src/repositories/tag-sync.repository.js';
import { DB } from 'src/schema/index.js';
import {
  getHiddenContentFilter,
  hiddenAssetIdExists,
  hiddenContentAssetIdExists,
  hiddenFromOthers,
  withHiddenContentFilter,
} from 'src/utils/database.js';
import {
  type HiddenContentQueryOptions,
  getHiddenContentQueryOptions,
  getOthersRulesQueryOptions,
} from 'src/utils/hidden-content.js';
import {
  effectiveVisibility,
  getLockedOwnerId,
  isDefaultVisible,
  isTimelineVisible,
  notLockedOrOwnedBy,
} from 'src/utils/locked.js';
import { mapSyncAssetV2 } from 'src/utils/sync.js';

export type SyncBackfillOptions = HiddenContentQueryOptions & {
  nowId: string;
  afterUpdateId?: string;
  beforeUpdateId: string;
};
const dummyBackfillOptions = {
  nowId: DummyValue.UUID,
  beforeUpdateId: DummyValue.UUID,
  afterUpdateId: DummyValue.UUID,
  excludeNsfw: true,
};
export type SyncCreatedAfterOptions = {
  nowId: string;
  userId: string;
  afterCreateId?: string;
};
const dummyCreateAfterOptions = {
  nowId: DummyValue.UUID,
  userId: DummyValue.UUID,
  afterCreateId: DummyValue.UUID,
};
export type SyncQueryOptions = HiddenContentQueryOptions & {
  nowId: string;
  userId: string;
  ack?: SyncAck;
};
const dummyQueryOptions = {
  nowId: DummyValue.UUID,
  userId: DummyValue.UUID,
  ack: {
    updateId: DummyValue.UUID,
  },
  excludeNsfw: true,
};
// FL-446: a cover another member owns is also withheld when it matches that owner's Locked rules
const albumThumbnailAssetId = (options: HiddenContentQueryOptions) => {
  const hidden = hiddenAssetIdExists(sql.ref('album.albumThumbnailAssetId'), options);
  return hidden
    ? sql<string | null>`case
        when ${hidden} then null
        else album."albumThumbnailAssetId"
      end`.as('thumbnailAssetId')
    : sql<string | null>`album."albumThumbnailAssetId"`.as('thumbnailAssetId');
};
const personFaceAssetId = (options: HiddenContentQueryOptions) => {
  const hiddenContent = getHiddenContentFilter(options);
  return hiddenContent
    ? sql<string | null>`case
        when ${hiddenContentAssetIdExists(sql.ref('person_face_asset.id'), hiddenContent)} then null
        else person."faceAssetId"
      end`.as('faceAssetId')
    : sql<string | null>`person."faceAssetId"`.as('faceAssetId');
};
/**
 * The sha1 a device compares its local files against. No recorded digest of an asset with a path checksum
 * (an external-library original, however it was recorded), nor any external scan's (FL-69), is sent:
 * bytes on an external mount are not a managed copy, so a device must never treat its own photo as backed
 * up because of them.
 */
const syncChecksum = () =>
  sql<Buffer>`coalesce(
    (select checksum.sha1 from public.asset_checksum checksum where checksum."assetId" = asset.id
      and asset."checksumAlgorithm" != ${sql.lit(ChecksumAlgorithm.sha1Path)}
      and checksum.evidence ->> 'source' is distinct from ${sql.lit(EXTERNAL_SCAN_CHECKSUM)}),
    asset.checksum
  )`.as('checksum');
/**
 * An album stream never carries another member's Locked media (owner decision, September 22, 2026):
 * the album keeps the item, but only its owner's own devices learn of it — not its id, file name,
 * thumbhash, checksum or exif. Applied to every album-asset and album-to-asset stream. Locked is the
 * lock record (FL-34, `src/utils/locked.ts`).
 */
const albumAssetVisibleTo = (userId: string) => notLockedOrOwnedBy(userId, 'asset');
/**
 * The visibility a device receives (FL-34): `locked` for a locked asset, so a client that keeps the
 * upstream Locked folder still files it there; the stored visibility otherwise.
 */
const syncVisibility = () => effectiveVisibility('asset').as('visibility');
const syncAssetColumns = columns.syncAsset.filter(
  (column) => column !== 'asset.checksum' && column !== 'asset.livePhotoVideoId' && column !== 'asset.visibility',
);
const syncLivePhotoVideoId = (options: HiddenContentQueryOptions) => {
  const hiddenContent = getHiddenContentFilter(options);
  return hiddenContent
    ? sql<string | null>`case
        when ${hiddenContentAssetIdExists(sql.ref('asset.livePhotoVideoId'), hiddenContent)} then null
        else asset."livePhotoVideoId"
      end`.as('livePhotoVideoId')
    : sql<string | null>`asset."livePhotoVideoId"`.as('livePhotoVideoId');
};
const syncAsset = (options: HiddenContentQueryOptions) =>
  [...syncAssetColumns, syncChecksum(), syncLivePhotoVideoId(options), syncVisibility()] as const;
const syncAlbumAssetColumns = columns.syncAlbumAsset.filter(
  (column) => column !== 'asset.checksum' && column !== 'asset.livePhotoVideoId' && column !== 'asset.visibility',
);
const syncAlbumAsset = (options: HiddenContentQueryOptions) =>
  [...syncAlbumAssetColumns, syncChecksum(), syncLivePhotoVideoId(options), syncVisibility()] as const;
@Injectable()
export class SyncRepository {
  tag: TagSync;
  album: AlbumSync;
  albumAsset: AlbumAssetSync;
  albumAssetExif: AlbumAssetExifSync;
  albumToAsset: AlbumToAssetSync;
  albumUser: AlbumUserSync;
  asset: AssetSync;
  assetExif: AssetExifSync;
  assetEdit: AssetEditSync;
  assetFace: AssetFaceSync;
  assetMetadata: AssetMetadataSync;
  assetOcr: AssetOcrSync;
  authUser: AuthUserSync;
  memory: MemorySync;
  memoryToAsset: MemoryToAssetSync;
  partner: PartnerSync;
  person: PersonSync;
  personGroup: PersonGroupSync;
  stack: StackSync;
  user: UserSync;
  userMetadata: UserMetadataSync;
  constructor(
    @InjectKysely()
    private db: Kysely<DB>,
  ) {
    this.tag = new TagSync(this.db, async (db, auth, kind, key) => {
      if (kind !== 'albumAsset') return [];
      const rows = await new AlbumAssetSync(db).getCurrent(auth, key);
      return rows.map(({ scopeId, updateId, ...asset }) => ({
        key: `${scopeId}:${asset.id}`,
        entityId: scopeId,
        assetId: asset.id,
        sourceId: updateId,
        data: { albumId: scopeId, asset: mapSyncAssetV2(asset) },
      }));
    });
    this.album = new AlbumSync(this.db);
    this.albumAsset = new AlbumAssetSync(this.db);
    this.albumAssetExif = new AlbumAssetExifSync(this.db);
    this.albumToAsset = new AlbumToAssetSync(this.db);
    this.albumUser = new AlbumUserSync(this.db);
    this.asset = new AssetSync(this.db);
    this.assetExif = new AssetExifSync(this.db);
    this.assetEdit = new AssetEditSync(this.db);
    this.assetFace = new AssetFaceSync(this.db);
    this.assetMetadata = new AssetMetadataSync(this.db);
    this.assetOcr = new AssetOcrSync(this.db);
    this.authUser = new AuthUserSync(this.db);
    this.memory = new MemorySync(this.db);
    this.memoryToAsset = new MemoryToAssetSync(this.db);
    this.partner = new PartnerSync(this.db);
    this.person = new PersonSync(this.db);
    this.personGroup = new PersonGroupSync(this.db);
    this.stack = new StackSync(this.db);
    this.user = new UserSync(this.db);
    this.userMetadata = new UserMetadataSync(this.db);
  }
}
export class BaseSync {
  constructor(protected db: Kysely<DB>) {}
  protected backfillQuery<T extends keyof DB>(t: T, { nowId, beforeUpdateId, afterUpdateId }: SyncBackfillOptions) {
    const { table, ref } = this.db.dynamic;
    const updateIdRef = ref(`${t}.updateId`);
    return this.db
      .selectFrom(table(t).as(t))
      .where(updateIdRef, '<', nowId)
      .where(updateIdRef, '<=', beforeUpdateId)
      .$if(!!afterUpdateId, (qb) => qb.where(updateIdRef, '>', afterUpdateId!))
      .orderBy(updateIdRef, 'asc');
  }
  protected auditQuery<T extends keyof DB>(t: T, { nowId, ack }: SyncQueryOptions) {
    const { table, ref } = this.db.dynamic;
    const idRef = ref(`${t}.id`);
    return this.db
      .selectFrom(table(t).as(t))
      .where(idRef, '<', nowId)
      .$if(!!ack, (qb) => qb.where(idRef, '>', ack!.updateId))
      .orderBy(idRef, 'asc');
  }
  protected auditCleanup<T extends keyof DB>(t: T, days: number) {
    const { table, ref } = this.db.dynamic;
    return this.db
      .deleteFrom(table(t).as(t))
      .where(ref(`${t}.deletedAt`), '<', sql.raw(`now() - interval '${days} days'`))
      .execute();
  }
  protected upsertQuery<T extends keyof DB>(t: T, { nowId, ack }: SyncQueryOptions) {
    const { table, ref } = this.db.dynamic;
    const updateIdRef = ref(`${t}.updateId`);
    return this.db
      .selectFrom(table(t).as(t))
      .where(updateIdRef, '<', nowId)
      .$if(!!ack, (qb) => qb.where(updateIdRef, '>', ack!.updateId))
      .orderBy(updateIdRef, 'asc');
  }
}
class AlbumSync extends BaseSync {
  /** V3 adds tree/trash fields; membership and parent-access changes refresh the payload. */
  private treeQuery(options: SyncQueryOptions) {
    const userId = options.userId;
    const parentGrant = this.db
      .selectFrom('album_user as parent_user')
      .select('parent_user.createId')
      .where('parent_user.albumId', '=', sql.ref<string>('album.parentId'))
      .where('parent_user.userId', '=', userId);
    const parentRevoke = this.db
      .selectFrom('album_audit as parent_audit')
      .select('parent_audit.id')
      .where('parent_audit.albumId', '=', sql.ref<string>('album.parentId'))
      .where('parent_audit.userId', '=', userId)
      .orderBy('parent_audit.id', 'desc')
      .limit(1);
    const eventId = sql<string>`greatest(album."updateId", album_users."createId",
      coalesce((${parentGrant}), album."updateId"), coalesce((${parentRevoke}), album."updateId"))`;
    return {
      eventId,
      query: this.db
        .selectFrom('album')
        .innerJoin('album_user as album_users', 'album.id', 'album_users.albumId')
        .where('album_users.userId', '=', userId)
        .select([
          'album.id',
          'album.albumName as name',
          'album.description',
          'album.createdAt',
          'album.updatedAt',
          albumThumbnailAssetId(options),
          'album.isActivityEnabled',
          'album.order',
          'album.kind',
          'album.icon',
          'album.sortOrder',
          'album.deletedAt',
          eventId.as('updateId'),
          sql<string | null>`case when (${parentGrant}) is not null then album."parentId" else null end`.as('parentId'),
        ]),
    };
  }
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getTreeUpserts(options: SyncQueryOptions) {
    const { query, eventId } = this.treeQuery(options);
    return query
      .where(eventId, '<', options.nowId)
      .$if(!!options.ack, (qb) =>
        options.ack!.extraId
          ? qb.where(
              sql<boolean>`(${eventId}, album.id) > (${options.ack!.updateId}::uuid, ${options.ack!.extraId}::uuid)`,
            )
          : qb.where(eventId, '>', options.ack!.updateId),
      )
      .orderBy(eventId, 'asc')
      .orderBy('album.id', 'asc')
      .stream();
  }
  @GenerateSql({
    params: [dummyQueryOptions, { timestamp: '2026-01-01T00:00:00.000001Z', id: DummyValue.UUID }],
    stream: true,
  })
  getTreeBootstrap(
    options: SyncQueryOptions,
    cursor?: {
      timestamp: string;
      id: string;
    },
  ) {
    const { query, eventId } = this.treeQuery(options);
    return query
      .where(eventId, '<', options.nowId)
      .select(
        sql<string>`to_char(album."createdAt" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'bootstrapTimestamp',
        ),
      )
      .$if(!!cursor, (qb) =>
        qb.where(
          sql<boolean>`(album."createdAt", album.id) < (${cursor!.timestamp}::timestamptz, ${cursor!.id}::uuid)`,
        ),
      )
      .orderBy('album.createdAt', 'desc')
      .orderBy('album.id', 'desc')
      .stream();
  }
  @GenerateSql({ params: [dummyCreateAfterOptions] })
  getCreatedAfter({ nowId, userId, afterCreateId }: SyncCreatedAfterOptions) {
    return this.db
      .selectFrom('album_user')
      .select(['albumId as id', 'createId'])
      .where('userId', '=', userId)
      .$if(!!afterCreateId, (qb) => qb.where('createId', '>=', afterCreateId!))
      .where('createId', '<', nowId)
      .orderBy('createId', 'asc')
      .execute();
  }
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('album_audit', options)
      .select(['id', 'albumId'])
      .where('userId', '=', options.userId)
      .stream();
  }
  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('album_audit', daysAgo);
  }
  @GenerateSql(
    { params: [dummyQueryOptions], stream: true },
    { name: 'v1', params: [dummyQueryOptions, true], stream: true },
  )
  getUpserts(options: SyncQueryOptions, includeOwner = false) {
    const userId = options.userId;
    return this.upsertQuery('album', options)
      .distinctOn(['album.id', 'album.updateId'])
      .leftJoin('album_user as album_users', 'album.id', 'album_users.albumId')
      .where('album_users.userId', '=', userId)
      .select([
        'album.id',
        'album.albumName as name',
        'album.description',
        'album.createdAt',
        'album.updatedAt',
        albumThumbnailAssetId(options),
        'album.isActivityEnabled',
        'album.order',
        'album.updateId',
      ])
      .$if(includeOwner, (qb) =>
        qb.select((eb) =>
          eb
            .selectFrom('album_user as album_owner')
            .select('album_owner.userId')
            .whereRef('album_owner.albumId', '=', 'album.id')
            .where('album_owner.role', '=', AlbumUserRole.Owner)
            .limit(1)
            .as('ownerId'),
        ),
      )
      .stream();
  }
}
class AlbumAssetSync extends BaseSync {
  getCurrent(auth: AuthDto, key?: string) {
    const options = { ...getHiddenContentQueryOptions(auth), ...getOthersRulesQueryOptions(auth) };
    return this.db
      .selectFrom('album_asset')
      .innerJoin('album_user', 'album_user.albumId', 'album_asset.albumId')
      .innerJoin('album', 'album.id', 'album_asset.albumId')
      .innerJoin('asset', 'asset.id', 'album_asset.assetId')
      .innerJoin('user as mediaOwner', 'mediaOwner.id', 'asset.ownerId')
      .where('mediaOwner.deletedAt', 'is', null)
      .where('album_user.userId', '=', auth.user.id)
      .where('album.deletedAt', 'is', null)
      .where('asset.deletedAt', 'is', null)
      .where(notLockedOrOwnedBy(getLockedOwnerId(auth)))
      .$call((qb) => withHiddenContentFilter(qb, options))
      .$if(!!key, (qb) =>
        qb.where('album.id', '=', key!.split(':', 1)[0]).where('asset.id', '=', key!.split(':', 2)[1]),
      )
      .select(syncAlbumAsset(options))
      .select(['album.id as scopeId', 'asset.updateId'])
      .select((eb) =>
        eb
          .case()
          .when('asset.ownerId', '=', auth.user.id)
          .then(eb.ref('asset.isFavorite'))
          .else(eb.val(false))
          .end()
          .as('isFavorite'),
      )
      .orderBy(sql`asset."fileCreatedAt" desc nulls last`)
      .orderBy('asset.id', 'desc')
      .orderBy('album.id', 'desc')
      .execute();
  }
  @GenerateSql({ params: [dummyBackfillOptions, DummyValue.UUID, DummyValue.UUID], stream: true })
  getBackfill(options: SyncBackfillOptions, albumId: string, userId: string) {
    return this.backfillQuery('album_asset', options)
      .innerJoin('asset', 'asset.id', 'album_asset.assetId')
      .select(syncAlbumAsset(options))
      .select((eb) =>
        eb
          .case()
          .when('asset.ownerId', '=', userId)
          .then(eb.ref('asset.isFavorite'))
          .else(eb.val(false))
          .end()
          .as('isFavorite'),
      )
      .select('album_asset.updateId')
      .where('album_asset.albumId', '=', albumId)
      .$call((qb) => withHiddenContentFilter(qb, options))
      .where(albumAssetVisibleTo(userId))
      .stream();
  }
  @GenerateSql({ params: [dummyQueryOptions, { updateId: DummyValue.UUID }], stream: true })
  getUpdates(options: SyncQueryOptions, albumToAssetAck: SyncAck) {
    const userId = options.userId;
    return this.upsertQuery('asset', options)
      .innerJoin('album_asset', 'album_asset.assetId', 'asset.id')
      .select(syncAlbumAsset(options))
      .select((eb) =>
        eb
          .case()
          .when('asset.ownerId', '=', userId)
          .then(eb.ref('asset.isFavorite'))
          .else(eb.val(false))
          .end()
          .as('isFavorite'),
      )
      .select('asset.updateId')
      .where('album_asset.updateId', '<=', albumToAssetAck.updateId) // Ensure we only send updates for assets that the client already knows about
      .innerJoin('album_user', 'album_user.albumId', 'album_asset.albumId')
      .where('album_user.userId', '=', userId)
      .$call((qb) => withHiddenContentFilter(qb, options))
      .where(albumAssetVisibleTo(userId))
      .stream();
  }
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getCreates(options: SyncQueryOptions) {
    const userId = options.userId;
    return this.upsertQuery('album_asset', options)
      .select('album_asset.updateId')
      .innerJoin('asset', 'asset.id', 'album_asset.assetId')
      .select(syncAlbumAsset(options))
      .select((eb) =>
        eb
          .case()
          .when('asset.ownerId', '=', userId)
          .then(eb.ref('asset.isFavorite'))
          .else(eb.val(false))
          .end()
          .as('isFavorite'),
      )
      .innerJoin('album_user', 'album_user.albumId', 'album_asset.albumId')
      .where('album_user.userId', '=', userId)
      .$call((qb) => withHiddenContentFilter(qb, options))
      .where(albumAssetVisibleTo(userId))
      .stream();
  }
}
class AlbumAssetExifSync extends BaseSync {
  @GenerateSql({ params: [dummyBackfillOptions, DummyValue.UUID, DummyValue.UUID], stream: true })
  getBackfill(options: SyncBackfillOptions, albumId: string, userId: string) {
    return this.backfillQuery('album_asset', options)
      .innerJoin('asset_exif', 'asset_exif.assetId', 'album_asset.assetId')
      .innerJoin('asset', 'asset.id', 'album_asset.assetId')
      .select(columns.syncAssetExif)
      .select('album_asset.updateId')
      .where('album_asset.albumId', '=', albumId)
      .$call((qb) => withHiddenContentFilter(qb, options))
      .where(albumAssetVisibleTo(userId))
      .stream();
  }
  @GenerateSql({ params: [dummyQueryOptions, { updateId: DummyValue.UUID }], stream: true })
  getUpdates(options: SyncQueryOptions, albumToAssetAck: SyncAck) {
    const userId = options.userId;
    return this.upsertQuery('asset_exif', options)
      .innerJoin('album_asset', 'album_asset.assetId', 'asset_exif.assetId')
      .innerJoin('asset', 'asset.id', 'asset_exif.assetId')
      .select(columns.syncAssetExif)
      .select('asset_exif.updateId')
      .where('album_asset.updateId', '<=', albumToAssetAck.updateId) // Ensure we only send exif updates for assets that the client already knows about
      .innerJoin('album_user', 'album_user.albumId', 'album_asset.albumId')
      .where('album_user.userId', '=', userId)
      .$call((qb) => withHiddenContentFilter(qb, options))
      .where(albumAssetVisibleTo(options.userId))
      .stream();
  }
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getCreates(options: SyncQueryOptions) {
    const userId = options.userId;
    return this.upsertQuery('album_asset', options)
      .select('album_asset.updateId')
      .innerJoin('asset_exif', 'asset_exif.assetId', 'album_asset.assetId')
      .innerJoin('asset', 'asset.id', 'album_asset.assetId')
      .select(columns.syncAssetExif)
      .innerJoin('album', 'album.id', 'album_asset.albumId')
      .leftJoin('album_user', 'album_user.albumId', 'album_asset.albumId')
      .where('album_user.userId', '=', userId)
      .$call((qb) => withHiddenContentFilter(qb, options))
      .where(albumAssetVisibleTo(options.userId))
      .stream();
  }
}
class AlbumToAssetSync extends BaseSync {
  @GenerateSql({ params: [dummyBackfillOptions, DummyValue.UUID, DummyValue.UUID], stream: true })
  getBackfill(options: SyncBackfillOptions, albumId: string, userId: string) {
    return this.backfillQuery('album_asset', options)
      .innerJoin('asset', 'asset.id', 'album_asset.assetId')
      .select(['album_asset.assetId as assetId', 'album_asset.albumId as albumId', 'album_asset.updateId'])
      .where('album_asset.albumId', '=', albumId)
      .$call((qb) => withHiddenContentFilter(qb, options))
      .where(albumAssetVisibleTo(userId))
      .stream();
  }
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    const userId = options.userId;
    return this.auditQuery('album_asset_audit', options)
      .select(['album_asset_audit.id', 'assetId', 'albumId'])
      .leftJoin('asset', 'asset.id', 'album_asset_audit.assetId')
      .where((eb) =>
        eb(
          'albumId',
          'in',
          eb.selectFrom('album_user').select(['album_user.albumId as id']).where('album_user.userId', '=', userId),
        ),
      )
      .$call((qb) => withHiddenContentFilter(qb, options))
      .stream();
  }
  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('album_asset_audit', daysAgo);
  }
  /**
   * FL-447: a fingerprint (md5) of the album items withheld from `userId` (owner decision, October 17,
   * 2026: Locked items and items hidden by their owner's Locked rules reach partners only): every
   * `albumId:assetId` pair, in the albums and shared spaces the user is a member of, of another member's
   * item that is locked (`albumAssetVisibleTo`, as the album streams filter it) or matches its owner's
   * Locked rules (`hiddenFromOthers`, Studio exports of such items included). With `before`, only the
   * pairs whose album item and membership already existed before that id count — the set as it stood
   * then, judged now — so an item or album added since is never a change. While no item is locked and no
   * account has a Locked rule the condition is a one-time filter and nothing is scanned.
   */
  async getWithheldFingerprint(userId: string, before?: string): Promise<string> {
    const row = await this.db
      .selectFrom('album_asset')
      .innerJoin('album_user', 'album_user.albumId', 'album_asset.albumId')
      .innerJoin('album', 'album.id', 'album_asset.albumId')
      .innerJoin('asset', 'asset.id', 'album_asset.assetId')
      .where('album_user.userId', '=', userId)
      .where('album.deletedAt', 'is', null)
      .where(
        sql<boolean>`(exists (select 1 from asset_lock) or exists (
          select 1
          from user_metadata as rules_owner
          where rules_owner.key = ${sql.lit(UserMetadataKey.Preferences)}
            and (
              jsonb_path_exists(rules_owner.value, '$.privacy.suppression.tagIds[*]')
              or jsonb_path_exists(rules_owner.value, '$.privacy.suppression.personIds[*]')
              or jsonb_path_exists(rules_owner.value, '$.privacy.suppression.petIds[*]')
            )
        ))`,
      )
      .where('asset.ownerId', '!=', userId)
      .where(sql<boolean>`(not ${albumAssetVisibleTo(userId)} or ${hiddenFromOthers(userId, 'asset')})`)
      .$if(!!before, (qb) => qb.where('album_asset.updateId', '<', before!).where('album_user.createId', '<', before!))
      .select(
        sql<string>`md5(coalesce(string_agg(album_asset."albumId"::text || ':' || album_asset."assetId"::text, ',' order by album_asset."albumId", album_asset."assetId"), ''))`.as(
          'fingerprint',
        ),
      )
      .executeTakeFirstOrThrow();
    return row.fingerprint;
  }
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    const userId = options.userId;
    return this.upsertQuery('album_asset', options)
      .innerJoin('asset', 'asset.id', 'album_asset.assetId')
      .select(['album_asset.assetId as assetId', 'album_asset.albumId as albumId', 'album_asset.updateId'])
      .innerJoin('album_user', 'album_user.albumId', 'album_asset.albumId')
      .where('album_user.userId', '=', userId)
      .$call((qb) => withHiddenContentFilter(qb, options))
      .where(albumAssetVisibleTo(userId))
      .stream();
  }
}
class AlbumUserSync extends BaseSync {
  @GenerateSql({ params: [dummyBackfillOptions, DummyValue.UUID], stream: true })
  getBackfill(options: SyncBackfillOptions, albumId: string) {
    return this.backfillQuery('album_user', options)
      .select(columns.syncAlbumUser)
      .select('album_user.updateId')
      .where('albumId', '=', albumId)
      .stream();
  }
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    const userId = options.userId;
    return this.auditQuery('album_user_audit', options)
      .select(['id', 'userId', 'albumId'])
      .where((eb) =>
        eb(
          'albumId',
          'in',
          eb.selectFrom('album_user').select(['album_user.albumId as id']).where('album_user.userId', '=', userId),
        ),
      )
      .stream();
  }
  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('album_user_audit', daysAgo);
  }
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    const userId = options.userId;
    return this.upsertQuery('album_user', options)
      .select(columns.syncAlbumUser)
      .select('album_user.updateId')
      .where((eb) =>
        eb(
          'album_user.albumId',
          'in',
          eb
            .selectFrom('album_user as albumUsers')
            .select(['albumUsers.albumId as id'])
            .where('albumUsers.userId', '=', userId),
        ),
      )
      .stream();
  }
}
class AssetSync extends BaseSync {
  /** Initial own-assets snapshot only: incremental delivery keeps its updateId ordering. */
  @GenerateSql({
    params: [dummyQueryOptions, { timestamp: '2026-01-01T00:00:00.000001Z', id: DummyValue.UUID }],
    stream: true,
  })
  getBootstrap(
    options: SyncQueryOptions,
    cursor?: {
      timestamp: string;
      id: string;
    },
  ) {
    const date = sql<string>`coalesce(asset."localDateTime", '-infinity'::timestamptz)`;
    return (
      this.db
        .selectFrom('asset')
        .select(syncAsset(options))
        // Preserve PostgreSQL microseconds; driver Date conversion loses cursor precision.
        .select(
          sql<string>`case when asset."localDateTime" is null then '-infinity'
        else to_char(asset."localDateTime" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end`.as(
            'bootstrapTimestamp',
          ),
        )
        .where('asset.updateId', '<', options.nowId)
        .where('asset.ownerId', '=', options.userId)
        .$call((qb) => withHiddenContentFilter(qb, options))
        .$if(!!cursor, (qb) =>
          qb.where(sql<boolean>`(${date}, asset.id) < (${cursor!.timestamp}::timestamptz, ${cursor!.id}::uuid)`),
        )
        .orderBy(date, 'desc')
        .orderBy('asset.id', 'desc')
        .stream()
    );
  }
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('asset_audit', options)
      .select(['id', 'assetId'])
      .where('ownerId', '=', options.userId)
      .stream();
  }
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getHiddenDeletes(options: SyncQueryOptions) {
    const hiddenContent = getHiddenContentFilter(options);
    let query = this.upsertQuery('asset_metadata', options)
      .innerJoin('asset', 'asset.id', 'asset_metadata.assetId')
      .select(['asset_metadata.updateId as id', 'asset.id as assetId'])
      .where('asset.ownerId', '=', options.userId)
      .where('asset.deletedAt', 'is', null);
    query = hiddenContent
      ? query.where(hiddenContentAssetIdExists(sql.ref('asset.id'), hiddenContent))
      : query.where(sql<boolean>`false`);
    return query.stream();
  }
  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('asset_audit', daysAgo);
  }
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('asset', options)
      .select(syncAsset(options))
      .select('asset.updateId')
      .where('ownerId', '=', options.userId)
      .$call((qb) => withHiddenContentFilter(qb, options))
      .stream();
  }
}
class AuthUserSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('user', options)
      .select(columns.syncUser)
      .select(['isAdmin', 'pinCode', 'oauthId', 'storageLabel', 'quotaSizeInBytes', 'quotaUsageInBytes'])
      .where('id', '=', options.userId)
      .stream();
  }
}
class PersonSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('person_audit', options)
      .select(['id', 'personGroupId as personId'])
      .where('ownerId', '=', options.userId)
      .stream();
  }
  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('person_audit', daysAgo);
  }
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('person', options)
      .select([
        'person.personGroupId as id',
        'person.createdAt',
        'person.updatedAt',
        'person.ownerId',
        'person.name',
        'person.birthDate',
        'person.isHidden',
        'person.isFavorite',
        'person.color',
        'person.updateId',
      ])
      .$if(!!getHiddenContentFilter(options), (qb) =>
        qb
          .leftJoin('asset_face as person_face', 'person_face.id', 'person.faceAssetId')
          .leftJoin('asset as person_face_asset', 'person_face_asset.id', 'person_face.assetId'),
      )
      .where('person.ownerId', '=', options.userId)
      .$if(!!getHiddenContentFilter(options), (qb) =>
        qb.where((eb) =>
          eb.or([
            eb.not((eb) =>
              eb.exists(
                eb
                  .selectFrom('asset_face')
                  .innerJoin('asset', (join) =>
                    join
                      .onRef('asset.id', '=', 'asset_face.assetId')
                      .on(isTimelineVisible('asset'))
                      .on('asset.deletedAt', 'is', null),
                  )
                  .whereRef('asset_face.personGroupId', '=', 'person.personGroupId')
                  .where('asset_face.deletedAt', 'is', null)
                  .where('asset_face.isVisible', 'is', true),
              ),
            ),
            eb.exists(
              eb
                .selectFrom('asset_face')
                .innerJoin('asset', (join) =>
                  join
                    .onRef('asset.id', '=', 'asset_face.assetId')
                    .on(isTimelineVisible('asset'))
                    .on('asset.deletedAt', 'is', null),
                )
                .whereRef('asset_face.personGroupId', '=', 'person.personGroupId')
                .where('asset_face.deletedAt', 'is', null)
                .where('asset_face.isVisible', 'is', true)
                .$call((qb) => withHiddenContentFilter(qb, options)),
            ),
          ]),
        ),
      )
      .select(personFaceAssetId(options))
      .stream();
  }
}
class PersonGroupSync extends BaseSync {
  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('person_group_audit', daysAgo);
  }
}
class AssetFaceSync extends BaseSync {
  // TODO(v5) drop when AssetFacesV2 is removed
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletesV2(options: SyncQueryOptions) {
    return this.auditQuery('asset_face_audit', options)
      .select(['asset_face_audit.id', 'assetFaceId'])
      .leftJoin('asset', 'asset.id', 'asset_face_audit.assetId')
      .where('asset.ownerId', '=', options.userId)
      .$call((qb) => withHiddenContentFilter(qb, options))
      .stream();
  }
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletesV3(options: SyncQueryOptions) {
    return this.auditQuery('asset_face_audit', options)
      .select(['asset_face_audit.id', 'assetFaceId'])
      .innerJoin('asset', 'asset.id', 'asset_face_audit.assetId')
      .innerJoin('user as owner', 'owner.id', 'asset.ownerId')
      .where((eb) => eb.or([eb('asset.ownerId', '=', options.userId), isDefaultVisible('asset')]))
      .where('owner.clusterGroupId', '=', ({ selectFrom }) =>
        selectFrom('user').select('user.clusterGroupId').where('user.id', '=', options.userId),
      )
      .$call((qb) => withHiddenContentFilter(qb, options))
      .stream();
  }
  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('asset_face_audit', daysAgo);
  }
  // TODO(v5) drop when AssetFacesV2 is removed
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpsertsV2(options: SyncQueryOptions) {
    return this.upsertQuery('asset_face', options)
      .select(columns.syncAssetFace)
      .select('asset_face.updateId')
      .leftJoin('asset', 'asset.id', 'asset_face.assetId')
      .where('asset.ownerId', '=', options.userId)
      .$call((qb) => withHiddenContentFilter(qb, options))
      .stream();
  }
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpsertsV3(options: SyncQueryOptions) {
    return this.upsertQuery('asset_face', options)
      .select(columns.syncAssetFace)
      .select('asset_face.updateId')
      .innerJoin('asset', 'asset.id', 'asset_face.assetId')
      .innerJoin('user as owner', 'owner.id', 'asset.ownerId')
      .where((eb) => eb.or([eb('asset.ownerId', '=', options.userId), isDefaultVisible('asset')]))
      .where('owner.clusterGroupId', '=', ({ selectFrom }) =>
        selectFrom('user').select('user.clusterGroupId').where('user.id', '=', options.userId),
      )
      .$call((qb) => withHiddenContentFilter(qb, options))
      .stream();
  }
}
class AssetExifSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('asset_exif', options)
      .innerJoin('asset', 'asset.id', 'asset_exif.assetId')
      .select(columns.syncAssetExif)
      .select('asset_exif.updateId')
      .where('asset.ownerId', '=', options.userId)
      .$call((qb) => withHiddenContentFilter(qb, options))
      .stream();
  }
}
class AssetEditSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('asset_edit_audit', options)
      .select(['asset_edit_audit.id', 'editId'])
      .innerJoin('asset', 'asset.id', 'asset_edit_audit.assetId')
      .where('asset.ownerId', '=', options.userId)
      .$call((qb) => withHiddenContentFilter(qb, options))
      .stream();
  }
  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('asset_edit_audit', daysAgo);
  }
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('asset_edit', options)
      .select([...columns.syncAssetEdit, 'asset_edit.updateId'])
      .innerJoin('asset', 'asset.id', 'asset_edit.assetId')
      .where('asset.ownerId', '=', options.userId)
      .$call((qb) => withHiddenContentFilter(qb, options))
      .stream();
  }
}
class MemorySync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('memory_audit', options)
      .select(['id', 'memoryId'])
      .where('userId', '=', options.userId)
      .stream();
  }
  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('memory_audit', daysAgo);
  }
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('memory', options)
      .select([
        'id',
        'createdAt',
        'updatedAt',
        'deletedAt',
        'ownerId',
        'type',
        'data',
        'isSaved',
        'memoryAt',
        'seenAt',
        'showAt',
        'hideAt',
      ])
      .select('updateId')
      .where('ownerId', '=', options.userId)
      .stream();
  }
}
class MemoryToAssetSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('memory_asset_audit', options)
      .select(['memory_asset_audit.id', 'memoryId', 'assetId'])
      .leftJoin('asset', 'asset.id', 'memory_asset_audit.assetId')
      .where('memoryId', 'in', (eb) => eb.selectFrom('memory').select('id').where('ownerId', '=', options.userId))
      .$call((qb) => withHiddenContentFilter(qb, options))
      .stream();
  }
  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('memory_asset_audit', daysAgo);
  }
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('memory_asset', options)
      .innerJoin('asset', 'asset.id', 'memory_asset.assetId')
      .select(['memory_asset.memoriesId as memoryId', 'memory_asset.assetId as assetId'])
      .select('memory_asset.updateId')
      .where('memoriesId', 'in', (eb) => eb.selectFrom('memory').select('id').where('ownerId', '=', options.userId))
      .$call((qb) => withHiddenContentFilter(qb, options))
      .stream();
  }
}
class PartnerSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    const userId = options.userId;
    return this.auditQuery('partner_audit', options)
      .select(['id', 'sharedById', 'sharedWithId'])
      .where((eb) => eb.or([eb('sharedById', '=', userId), eb('sharedWithId', '=', userId)]))
      .stream();
  }
  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('partner_audit', daysAgo);
  }
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    const userId = options.userId;
    return this.upsertQuery('partner', options)
      .select(['sharedById', 'sharedWithId', 'inTimeline', 'updateId'])
      .where((eb) => eb.or([eb('sharedById', '=', userId), eb('sharedWithId', '=', userId)]))
      .stream();
  }
}
class StackSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('stack_audit', options)
      .select(['id', 'stackId'])
      .where('userId', '=', options.userId)
      .stream();
  }
  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('stack_audit', daysAgo);
  }
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('stack', options)
      .innerJoin('asset', 'asset.id', 'stack.primaryAssetId')
      .select(columns.syncStack)
      .select('stack.updateId')
      .where('stack.ownerId', '=', options.userId)
      .$call((qb) => withHiddenContentFilter(qb, options))
      .stream();
  }
}
class UserSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('user_audit', options).select(['id', 'userId']).stream();
  }
  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('user_audit', daysAgo);
  }
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('user', options).select(columns.syncUser).stream();
  }
}
class UserMetadataSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getDeletes(options: SyncQueryOptions) {
    return this.auditQuery('user_metadata_audit', options)
      .select(['id', 'userId', 'key'])
      .where('userId', '=', options.userId)
      .stream();
  }
  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('user_metadata_audit', daysAgo);
  }
  @GenerateSql({ params: [dummyQueryOptions], stream: true })
  getUpserts(options: SyncQueryOptions) {
    return this.upsertQuery('user_metadata', options)
      .select(['userId', 'key', 'value', 'updateId'])
      .where('userId', '=', options.userId)
      .stream();
  }
}
class AssetMetadataSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions, DummyValue.UUID], stream: true })
  getDeletes(options: SyncQueryOptions, userId: string) {
    return this.auditQuery('asset_metadata_audit', options)
      .select(['asset_metadata_audit.id', 'assetId', 'key'])
      .leftJoin('asset', 'asset.id', 'asset_metadata_audit.assetId')
      .where('asset.ownerId', '=', userId)
      .where('asset_metadata_audit.key', '!=', AssetMetadataKey.MlEnrichment)
      .$call((qb) => withHiddenContentFilter(qb, options))
      .stream();
  }
  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('asset_metadata_audit', daysAgo);
  }
  @GenerateSql({ params: [dummyQueryOptions, DummyValue.UUID], stream: true })
  getUpserts(options: SyncQueryOptions, userId: string) {
    return this.upsertQuery('asset_metadata', options)
      .select(['assetId', 'key', 'value', 'asset_metadata.updateId'])
      .innerJoin('asset', 'asset.id', 'asset_metadata.assetId')
      .where('asset.ownerId', '=', userId)
      .where('asset_metadata.key', '!=', AssetMetadataKey.MlEnrichment)
      .$call((qb) => withHiddenContentFilter(qb, options))
      .stream();
  }
}
class AssetOcrSync extends BaseSync {
  @GenerateSql({ params: [dummyQueryOptions, DummyValue.UUID], stream: true })
  getDeletes(options: SyncQueryOptions, userId: string) {
    return this.auditQuery('asset_ocr_audit', options)
      .select(['asset_ocr_audit.id', 'asset_ocr_audit.assetId', 'asset_ocr_audit.deletedAt'])
      .leftJoin('asset', 'asset.id', 'asset_ocr_audit.assetId')
      .where('asset.ownerId', '=', userId)
      .$call((qb) => withHiddenContentFilter(qb, options))
      .stream();
  }
  cleanupAuditTable(daysAgo: number) {
    return this.auditCleanup('asset_ocr_audit', daysAgo);
  }
  @GenerateSql({ params: [dummyQueryOptions, DummyValue.UUID], stream: true })
  getUpserts(options: SyncQueryOptions, userId: string) {
    return this.upsertQuery('asset_ocr', options)
      .select(columns.syncAssetOcr)
      .innerJoin('asset', 'asset.id', 'asset_ocr.assetId')
      .where('asset.ownerId', '=', userId)
      .$call((qb) => withHiddenContentFilter(qb, options))
      .stream();
  }
}
