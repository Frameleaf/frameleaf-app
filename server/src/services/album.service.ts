import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { ALBUM_ICON_GROUPS, MDI_ICON_CATALOGUE_VERSION, MDI_ICON_NAMES } from 'src/constants/album-icons.js';
import {
  AddUsersDto,
  AlbumDescendantCountResponseDto,
  AlbumIconCatalogueResponseDto,
  AlbumResponseDto,
  AlbumStatisticsResponseDto,
  AlbumTreeResponseDto,
  AlbumsAddAssetsDto,
  AlbumsAddAssetsResponseDto,
  CreateAlbumDto,
  GetAlbumInfoDto,
  GetAlbumsDto,
  MapAlbumDto,
  MoveAlbumDto,
  UpdateAlbumDto,
  UpdateAlbumUserDto,
  asAlbumKind,
  mapAlbum,
} from 'src/dtos/album.dto.js';
import { BulkIdErrorReason, BulkIdResponseDto, BulkIdsDto } from 'src/dtos/asset-ids.response.dto.js';
import { MapMarkerResponseDto } from 'src/dtos/map.dto.js';
import { AlbumKind, AlbumUserRole, Permission } from 'src/enum.js';
import { AlbumAssetCount, AlbumInfoOptions } from 'src/repositories/album.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { buildAlbumTree } from 'src/utils/album-tree.js';
import { addAssets, removeAssets } from 'src/utils/asset.util.js';
import { asDateTimeString } from 'src/utils/date.js';
import { getHiddenContentQueryOptions, getPrivacyQueryOptions } from 'src/utils/hidden-content.js';
import { getPreferences } from 'src/utils/preferences.js';

@Injectable()
export class AlbumService extends BaseService {
  async getStatistics(auth: AuthDto): Promise<AlbumStatisticsResponseDto> {
    const [owned, shared, notShared] = await Promise.all([
      this.albumRepository.getAll(auth.user.id, { isOwned: true }),
      this.albumRepository.getAll(auth.user.id, { isShared: true }),
      this.albumRepository.getAll(auth.user.id, { isOwned: true, isShared: false }),
    ]);

    return {
      owned: owned.length,
      shared: shared.length,
      notShared: notShared.length,
    };
  }

  async getAll(auth: AuthDto, { assetId, suppressedOnly, ...rest }: GetAlbumsDto): Promise<AlbumResponseDto[]> {
    await this.albumRepository.updateThumbnails();

    const ownerId = auth.user.id;
    const privacyOptions = this.nsfwOptions(auth, suppressedOnly);
    let albums: MapAlbumDto[] = assetId
      ? await this.albumRepository.getByAssetId(ownerId, assetId, privacyOptions)
      : await this.albumRepository.getAll(ownerId, rest);

    if (albums.length === 0) {
      return [];
    }
    // Get asset count for each album. Then map the result to an object:
    // { [albumId]: assetCount }
    const results = await this.albumRepository.getMetadataForIds(
      albums.map((album) => album.id),
      privacyOptions,
    );
    const albumMetadata: Record<string, AlbumAssetCount> = {};
    for (const metadata of results) {
      albumMetadata[metadata.albumId] = metadata;
    }
    albums = await this.hideNsfwAlbumThumbnails(auth, albums, privacyOptions, albumMetadata);

    return albums.map((album) => this.toListItem(album, albumMetadata));
  }

  /**
   * The album directory: collections with their albums, albums on their own,
   * and shared spaces, for everything the requesting user owns or is shared
   * with. Access is the same membership rule as `getAll`; partner and shared
   * link rules are unchanged (neither grants album listing).
   */
  async getTree(auth: AuthDto): Promise<AlbumTreeResponseDto> {
    await this.albumRepository.updateThumbnails();

    const privacyOptions = this.nsfwOptions(auth);
    let albums: MapAlbumDto[] = await this.albumRepository.getAll(auth.user.id, {});
    if (albums.length === 0) {
      return buildAlbumTree([]);
    }

    const ids = albums.map((album) => album.id);
    const [results, smartBackedIds] = await Promise.all([
      this.albumRepository.getMetadataForIds(ids, privacyOptions),
      this.smartAlbumRepository.getSmartBackedAlbumIds(ids),
    ]);
    const albumMetadata: Record<string, AlbumAssetCount> = {};
    for (const metadata of results) {
      albumMetadata[metadata.albumId] = metadata;
    }
    albums = await this.hideNsfwAlbumThumbnails(auth, albums, privacyOptions, albumMetadata);

    return buildAlbumTree(
      albums.map((album) => ({ ...this.toListItem(album, albumMetadata), isSmart: smartBackedIds.has(album.id) })),
    );
  }

  /** The icon catalogue as data: every valid name plus the categorised suggested set. */
  getIconCatalogue(): AlbumIconCatalogueResponseDto {
    return {
      version: MDI_ICON_CATALOGUE_VERSION,
      names: [...MDI_ICON_NAMES],
      suggested: ALBUM_ICON_GROUPS.map((group) => ({
        label: group.label,
        icons: group.icons.map(({ name, label }) => ({ name, label })),
      })),
    };
  }

  private toListItem(album: MapAlbumDto, albumMetadata: Record<string, AlbumAssetCount>): AlbumResponseDto {
    return {
      ...mapAlbum(album),
      startDate: asDateTimeString(albumMetadata[album.id]?.startDate ?? undefined),
      endDate: asDateTimeString(albumMetadata[album.id]?.endDate ?? undefined),
      assetCount: albumMetadata[album.id]?.assetCount ?? 0,
      // lastModifiedAssetTimestamp is only used in mobile app, please remove if not need
      lastModifiedAssetTimestamp: asDateTimeString(albumMetadata[album.id]?.lastModifiedAssetTimestamp ?? undefined),
    };
  }

  async get(auth: AuthDto, id: string, { suppressedOnly }: GetAlbumInfoDto = {}): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [id] });
    await this.albumRepository.updateThumbnails();
    const privacyOptions = this.nsfwOptions(auth, suppressedOnly);
    const album = await this.findOrFail(id, auth, { withAssets: false });
    const [albumMetadataForIds] = await this.albumRepository.getMetadataForIds([album.id], privacyOptions);

    const hasSharedUsers = album.albumUsers && album.albumUsers.length > 1;
    const hasSharedLink = album.sharedLinks && album.sharedLinks.length > 0;
    const isShared = hasSharedUsers || hasSharedLink;
    const [mappedAlbum] = await this.hideNsfwAlbumThumbnails(auth, [album], privacyOptions, {
      [album.id]: albumMetadataForIds,
    });

    return {
      ...mapAlbum(mappedAlbum),
      startDate: asDateTimeString(albumMetadataForIds?.startDate ?? undefined),
      endDate: asDateTimeString(albumMetadataForIds?.endDate ?? undefined),
      assetCount: albumMetadataForIds?.assetCount ?? 0,
      lastModifiedAssetTimestamp: asDateTimeString(albumMetadataForIds?.lastModifiedAssetTimestamp ?? undefined),
      contributorCounts: isShared
        ? await this.albumRepository.getContributorCounts(album.id, privacyOptions)
        : undefined,
    };
  }

  async getMapMarkers(auth: AuthDto, id: string): Promise<MapMarkerResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [id] });

    if (auth.sharedLink && !auth.sharedLink.showExif) {
      return [];
    }

    return this.mapRepository.getAlbumMapMarkers(id, this.nsfwOptions(auth));
  }

  async create(auth: AuthDto, dto: CreateAlbumDto): Promise<AlbumResponseDto> {
    const albumUsers = (dto.albumUsers || []).filter(({ userId }) => userId !== auth.user.id);

    for (const { userId } of albumUsers) {
      const exists = await this.userRepository.get(userId, {});
      if (!exists) {
        this.logger.debug('Album creation failed: user not found');
        throw new BadRequestException('Invalid user');
      }
    }

    const kind = dto.kind ?? AlbumKind.Album;
    if (dto.parentId) {
      if (kind !== AlbumKind.Album) {
        throw new BadRequestException('Collections and shared spaces stay at the top level');
      }
      // Nesting changes the collection, so require AlbumUpdate on it (owner or editor).
      await this.requireAccess({ auth, permission: Permission.AlbumUpdate, ids: [dto.parentId] });
      await this.requireCollection(auth, dto.parentId);
    }

    const allowedAssetIdsSet = await this.checkAccess({
      auth,
      permission: Permission.AssetShare,
      ids: dto.assetIds || [],
    });
    const assetIds = [...allowedAssetIdsSet].map((id) => id);

    const userMetadata = await this.userRepository.getMetadata(auth.user.id);

    const album = await this.albumRepository.create(
      {
        albumName: dto.albumName,
        description: dto.description,
        albumThumbnailAssetId: assetIds[0] || null,
        order: getPreferences(userMetadata).albums.defaultAssetOrder,
        parentId: dto.parentId ?? null,
        icon: dto.icon ?? null,
        kind,
      },
      assetIds,
      [{ userId: auth.user.id, role: AlbumUserRole.Owner }, ...albumUsers],
      auth.user.id,
    );

    for (const { userId } of albumUsers) {
      await this.eventRepository.emit('AlbumInvite', { id: album.id, userId, senderName: auth.user.name });
    }

    return mapAlbum(album);
  }

  async update(auth: AuthDto, id: string, dto: UpdateAlbumDto): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumUpdate, ids: [id] });

    const privacyOptions = this.nsfwOptions(auth);
    const album = await this.findOrFail(id, auth, { withAssets: true });

    if (dto.albumThumbnailAssetId) {
      const visibleAssetIds = new Set(album.assets?.map((asset) => asset.id));
      if (!visibleAssetIds.has(dto.albumThumbnailAssetId)) {
        throw new BadRequestException('Invalid album thumbnail');
      }
    }

    if (dto.parentId !== undefined && dto.parentId !== album.parentId) {
      await this.validateAndReparent(auth, album, dto.parentId);
    }

    const updatedAlbum = await this.albumRepository.update(
      album.id,
      {
        id: album.id,
        albumName: dto.albumName,
        description: dto.description,
        albumThumbnailAssetId: dto.albumThumbnailAssetId,
        isActivityEnabled: dto.isActivityEnabled,
        order: dto.order,
        icon: dto.icon,
        sortOrder: dto.sortOrder,
      },
      auth.user.id,
    );

    const [mappedAlbum] = await this.hideNsfwAlbumThumbnails(
      auth,
      [{ ...updatedAlbum, assets: album.assets }],
      privacyOptions,
    );
    return mapAlbum(mappedAlbum);
  }

  async getDescendantCount(auth: AuthDto, id: string): Promise<AlbumDescendantCountResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [id] });
    const count = await this.albumRepository.getDescendantCount(id);
    return { count };
  }

  /** Move an album into a collection, or out of one (`collectionId: null`) so it stands on its own. */
  async moveToCollection(auth: AuthDto, id: string, dto: MoveAlbumDto): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumUpdate, ids: [id] });
    const album = await this.findOrFail(id, auth, { withAssets: false });
    if (album.parentId !== dto.collectionId) {
      await this.validateAndReparent(auth, album, dto.collectionId);
    }
    return this.get(auth, id);
  }

  /**
   * One level of nesting: only an album moves, only into a collection, and only
   * its owner reorganises it (parentId is a single stored value, so an editor
   * of a shared album must not rewrite the owner's organisation). The
   * destination needs AlbumUpdate (owner or editor of the collection).
   */
  private async validateAndReparent(
    auth: AuthDto,
    album: { id: string; kind: string; albumUsers: { role: AlbumUserRole; user: { id: string } }[] },
    newParentId: string | null,
  ): Promise<void> {
    if (newParentId === album.id) {
      throw new BadRequestException('An album cannot be its own parent');
    }

    if (asAlbumKind(album.kind) !== AlbumKind.Album) {
      throw new BadRequestException('Collections and shared spaces stay at the top level');
    }

    const owner = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner);
    if (owner?.user.id !== auth.user.id) {
      throw new BadRequestException('Only the album owner can move it');
    }

    if (newParentId !== null) {
      await this.requireAccess({ auth, permission: Permission.AlbumUpdate, ids: [newParentId] });
      await this.requireCollection(auth, newParentId);
    }

    // The descendant/cycle check runs inside reparent's transaction (atomic with
    // the parent update) to avoid a TOCTOU race between concurrent reparents.
    await this.albumRepository.reparent(album.id, newParentId);
  }

  private async requireCollection(auth: AuthDto, id: string): Promise<void> {
    const parent = await this.findOrFail(id, auth, { withAssets: false });
    if (asAlbumKind(parent.kind) !== AlbumKind.Collection) {
      throw new BadRequestException('Albums nest only inside a collection');
    }
  }

  /**
   * Deleting a collection leaves its albums standing on their own; deleting an
   * album keeps every original file in the library. Nested legacy albums under
   * a plain album still follow the existing cascade.
   */
  async delete(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AlbumDelete, ids: [id] });
    const album = await this.findOrFail(id, auth, { withAssets: false });
    if (asAlbumKind(album.kind) === AlbumKind.Collection) {
      for (const childId of await this.albumRepository.getChildIds(id)) {
        await this.albumRepository.reparent(childId, null);
      }
    }
    await this.albumRepository.delete(id);
  }

  async addAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    const album = await this.findOrFail(id, auth, { withAssets: false });
    await this.requireAccess({ auth, permission: Permission.AlbumAssetCreate, ids: [id] });

    const results = await addAssets(
      auth,
      { access: this.accessRepository, bulk: this.albumRepository },
      { parentId: id, assetIds: dto.ids, permission: Permission.AssetShare },
    );

    const { id: firstNewAssetId } = results.find(({ success }) => success) || {};
    if (firstNewAssetId) {
      await this.albumRepository.update(
        id,
        {
          id,
          updatedAt: new Date(),
          albumThumbnailAssetId: album.albumThumbnailAssetId ?? firstNewAssetId,
        },
        auth.user.id,
      );

      const userIds = album.albumUsers.map(({ user }) => user.id);
      const recipientIds = userIds.filter((userId) => userId !== auth.user.id);
      await this.eventRepository.emit('AlbumUpdate', { id, userIds, recipientIds });
    }

    return results;
  }

  async addAssetsToAlbums(auth: AuthDto, dto: AlbumsAddAssetsDto): Promise<AlbumsAddAssetsResponseDto> {
    const results: AlbumsAddAssetsResponseDto = {
      success: false,
      error: BulkIdErrorReason.DUPLICATE,
    };

    const allowedAlbumIds = await this.checkAccess({
      auth,
      permission: Permission.AlbumAssetCreate,
      ids: dto.albumIds,
    });
    if (allowedAlbumIds.size === 0) {
      results.error = BulkIdErrorReason.NO_PERMISSION;
      return results;
    }

    const allowedAssetIds = await this.checkAccess({ auth, permission: Permission.AssetShare, ids: dto.assetIds });
    if (allowedAssetIds.size === 0) {
      results.error = BulkIdErrorReason.NO_PERMISSION;
      return results;
    }

    const albumAssetValues: { albumId: string; assetId: string }[] = [];
    const events: { id: string; userIds: string[]; recipientIds: string[] }[] = [];
    for (const albumId of allowedAlbumIds) {
      const existingAssetIds = await this.albumRepository.getAssetIds(albumId, [...allowedAssetIds]);
      const notPresentAssetIds = [...allowedAssetIds.difference(existingAssetIds)];
      if (notPresentAssetIds.length === 0) {
        continue;
      }
      const album = await this.findOrFail(albumId, auth, { withAssets: false });
      results.error = undefined;
      results.success = true;

      for (const assetId of notPresentAssetIds) {
        albumAssetValues.push({ albumId, assetId });
      }
      await this.albumRepository.update(
        albumId,
        {
          id: albumId,
          updatedAt: new Date(),
          albumThumbnailAssetId: album.albumThumbnailAssetId ?? notPresentAssetIds[0],
        },
        auth.user.id,
      );
      const userIds = album.albumUsers.map(({ user }) => user.id);
      const recipientIds = userIds.filter((userId) => userId !== auth.user.id);
      events.push({ id: albumId, userIds, recipientIds });
    }

    await this.albumRepository.addAssetIdsToAlbums(albumAssetValues);
    for (const event of events) {
      await this.eventRepository.emit('AlbumUpdate', event);
    }

    return results;
  }

  async removeAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AlbumAssetDelete, ids: [id] });

    const album = await this.findOrFail(id, auth, { withAssets: false });
    const results = await removeAssets(
      auth,
      { access: this.accessRepository, bulk: this.albumRepository },
      { parentId: id, assetIds: dto.ids, canAlwaysRemove: Permission.AlbumDelete },
    );

    const removedIds = results.filter(({ success }) => success).map(({ id }) => id);
    if (removedIds.length > 0) {
      if (album.albumThumbnailAssetId && removedIds.includes(album.albumThumbnailAssetId)) {
        await this.albumRepository.updateThumbnails();
      }

      await this.eventRepository.emit('AlbumUpdate', {
        id,
        userIds: album.albumUsers.map(({ user }) => user.id),
        recipientIds: [],
      });
    }

    return results;
  }

  async addUsers(auth: AuthDto, id: string, { albumUsers }: AddUsersDto): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });

    const album = await this.findOrFail(id, auth, { withAssets: false });

    for (const { userId, role } of albumUsers) {
      if (role === AlbumUserRole.Owner) {
        throw new BadRequestException('Cannot add another owner');
      }

      const exists = album.albumUsers.some(({ user: { id } }) => id === userId);
      if (exists) {
        continue;
      }

      const user = await this.userRepository.get(userId, {});
      if (!user) {
        this.logger.debug('Adding user to album failed: user not found');
        throw new BadRequestException('Invalid user');
      }

      await this.albumUserRepository.create({ userId, albumId: id, role });
      await this.eventRepository.emit('AlbumInvite', { id, userId, senderName: auth.user.name });
    }

    const updatedAlbum = await this.findOrFail(id, auth, { withAssets: true });
    const [mappedAlbum] = await this.hideNsfwAlbumThumbnails(auth, [updatedAlbum]);
    return mapAlbum(mappedAlbum);
  }

  async removeUser(auth: AuthDto, id: string, userId: string | 'me'): Promise<void> {
    if (userId === 'me') {
      userId = auth.user.id;
    }

    const album = await this.findOrFail(id, auth, { withAssets: false });

    const exists = album.albumUsers.find(({ user: { id } }) => id === userId);
    if (!exists) {
      throw new BadRequestException('Album not shared with user');
    }

    if (
      exists.role === AlbumUserRole.Owner &&
      album.albumUsers.filter(({ role }) => role === AlbumUserRole.Owner).length === 1
    ) {
      throw new BadRequestException('Cannot remove the last album owner');
    }

    // non-admin can remove themselves
    if (auth.user.id !== userId) {
      await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });
    }

    await this.albumUserRepository.delete({ albumId: id, userId });
  }

  async updateUser(auth: AuthDto, id: string, userId: string, dto: UpdateAlbumUserDto): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });

    const album = await this.findOrFail(id, auth, { withAssets: false });
    const owner = album.albumUsers[0];

    if (owner.user.id === userId) {
      throw new BadRequestException('User is owner');
    }

    await this.albumUserRepository.update({ albumId: id, userId }, { role: dto.role });
  }

  private nsfwOptions(auth: AuthDto, suppressedOnly?: boolean) {
    return suppressedOnly ? getPrivacyQueryOptions(auth, true) : getHiddenContentQueryOptions(auth);
  }

  private async hideNsfwAlbumThumbnails<T extends MapAlbumDto>(
    auth: AuthDto,
    albums: T[],
    options = this.nsfwOptions(auth),
    albumMetadata: Record<string, AlbumAssetCount | undefined> = {},
  ): Promise<T[]> {
    if (options.onlyHiddenContent) {
      return albums.map((album) => ({
        ...album,
        albumThumbnailAssetId: albumMetadata[album.id]?.thumbnailAssetId ?? null,
      }));
    }

    if (!options.excludeNsfw && !options.hiddenContent && !options.onlyHiddenContent) {
      return albums;
    }

    const thumbnailIds = albums.flatMap(({ albumThumbnailAssetId }) =>
      albumThumbnailAssetId ? [albumThumbnailAssetId] : [],
    );
    const nsfwThumbnailIds = await this.assetRepository.getHiddenContentAssetIds(thumbnailIds, options);

    return albums.map((album) =>
      album.albumThumbnailAssetId && nsfwThumbnailIds.has(album.albumThumbnailAssetId)
        ? { ...album, albumThumbnailAssetId: null }
        : album,
    );
  }

  private async findOrFail(id: string, auth: AuthDto, options: AlbumInfoOptions) {
    const album = await this.albumRepository.getById(id, { ...options, ...this.nsfwOptions(auth) }, auth.user.id);
    if (!album) {
      throw new BadRequestException('Album not found');
    }
    return album;
  }
}
