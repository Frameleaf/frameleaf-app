import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { AlbumMapMarkerSearchOptions } from 'src/repositories/map.repository.js';
import { ALBUM_ICON_GROUPS, MDI_ICON_CATALOGUE_VERSION, MDI_ICON_NAMES } from 'src/constants/album-icons.js';
import {
  AddUsersDto,
  AlbumDescendantCountResponseDto,
  AlbumIconCatalogueResponseDto,
  AlbumOrderDto,
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
import { AlbumMapMarkerDto, MapMarkerResponseDto } from 'src/dtos/map.dto.js';
import { AlbumKind, AlbumUserRole, Permission, SharedSpaceEventType } from 'src/enum.js';
import { AlbumAssetCount, AlbumInfoOptions, AlbumReadOptions } from 'src/repositories/album.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { albumOrderGroup, buildAlbumTree, orderAlbumTree } from 'src/utils/album-tree.js';
import { addAssets, removeAssets } from 'src/utils/asset.util.js';
import { asDateTimeString } from 'src/utils/date.js';
import { getHiddenContentQueryOptions, getPrivacyQueryOptions } from 'src/utils/hidden-content.js';
import { getLockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { isLockedRow } from 'src/utils/locked.js';
import { getLocationHiddenOwnerIdsForView } from 'src/utils/partner-location.js';
import { getPreferences } from 'src/utils/preferences.js';
import { isSharedSpace, requireInvitableRole, requireSpaceOwner } from 'src/utils/shared-space.js';

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

    const readable = await this.readableParents(auth, albums);
    return albums.map((album) => this.withReadableParent(this.toListItem(album, albumMetadata), readable));
  }

  /**
   * FL-52: an album's collection is the owner's organisation. Somebody the album is shared with
   * sees `parentId` only when they can read that collection too; otherwise the album stands on its
   * own for them and the private collection's id never leaves the server.
   */
  private async readableParents(auth: AuthDto, albums: { parentId: string | null }[]): Promise<Set<string>> {
    const parentIds = [...new Set(albums.map(({ parentId }) => parentId).filter((id): id is string => !!id))];
    if (parentIds.length === 0) {
      return new Set();
    }
    return this.checkAccess({ auth, permission: Permission.AlbumRead, ids: parentIds });
  }

  private withReadableParent<T extends { parentId: string | null }>(album: T, readable: Set<string>): T {
    return album.parentId && !readable.has(album.parentId) ? { ...album, parentId: null } : album;
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
    const [results, smartBackedIds, ruleAlbumIds, rules, positions] = await Promise.all([
      this.albumRepository.getMetadataForIds(ids, privacyOptions),
      this.smartAlbumRepository.getSmartBackedAlbumIds(ids),
      this.classificationRepository.getRuleAlbumIds(ids),
      this.classificationRepository.getRules(auth.user.id),
      this.albumRepository.getPositions(auth.user.id),
    ]);
    const ruleByAlbum = new Map(rules.map((rule) => [rule.albumId, rule.id]));
    const albumMetadata: Record<string, AlbumAssetCount> = {};
    for (const metadata of results) {
      albumMetadata[metadata.albumId] = metadata;
    }
    albums = await this.hideNsfwAlbumThumbnails(auth, albums, privacyOptions, albumMetadata);

    // Every group comes back in the person's own custom order (FL-52); the client's "Custom order"
    // sort shows it as is, the other sorts re-sort it.
    const readable = await this.readableParents(auth, albums);
    return orderAlbumTree(
      buildAlbumTree(
        albums.map((album) => ({
          ...this.withReadableParent(this.toListItem(album, albumMetadata), readable),
          isSmart: smartBackedIds.has(album.id) || ruleAlbumIds.has(album.id),
          smartRuleId: ruleByAlbum.get(album.id) ?? null,
        })),
      ),
      positions,
    );
  }

  /**
   * Save the person's custom order for one group of their directory (FL-52): the albums inside a
   * collection, or the collections, the albums on their own or the shared spaces at the top level.
   * The order is theirs alone and changes organization only — no access, membership or album row.
   *
   * The ids must be exactly the group as it is now. An order made from an outdated directory (an
   * album moved in or out, created, deleted or shared away since the client loaded it) is refused
   * with 409 so the client reloads instead of saving positions for a group that no longer exists.
   */
  async setOrder(auth: AuthDto, dto: AlbumOrderDto): Promise<void> {
    const albumIds = dto.albumIds;
    if (new Set(albumIds).size !== albumIds.length) {
      throw new BadRequestException('Each album may appear only once');
    }
    // The group is read and the order written in one transaction, with the albums locked against a
    // concurrent move, so an order can never be saved for a group that changed in between.
    await this.albumRepository.setPositions(auth.user.id, albumIds, (visible) => {
      const group = albumOrderGroup(visible, dto.parentId, albumIds[0]);
      if (!group) {
        if (visible.every(({ id }) => id !== albumIds[0])) {
          throw new BadRequestException('Not found or no album.read access');
        }
        throw new ConflictException('The album directory changed since it was loaded');
      }
      const expected = new Set(group);
      if (expected.size !== albumIds.length || albumIds.some((id) => !expected.has(id))) {
        throw new ConflictException('The album directory changed since it was loaded');
      }
    });
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

    const readable = await this.readableParents(auth, [mappedAlbum]);
    return {
      ...this.withReadableParent(mapAlbum(mappedAlbum), readable),
      startDate: asDateTimeString(albumMetadataForIds?.startDate ?? undefined),
      endDate: asDateTimeString(albumMetadataForIds?.endDate ?? undefined),
      assetCount: albumMetadataForIds?.assetCount ?? 0,
      lastModifiedAssetTimestamp: asDateTimeString(albumMetadataForIds?.lastModifiedAssetTimestamp ?? undefined),
      contributorCounts: isShared
        ? await this.albumRepository.getContributorCounts(album.id, privacyOptions)
        : undefined,
      ...(await this.smartStateOf(auth, album.id)),
    };
  }

  /**
   * Whether an album is filled automatically (FL-60): a built-in smart album, or one of the viewer's
   * own classification rules. Another person's rule id is never returned.
   */
  private async smartStateOf(
    auth: AuthDto,
    albumId: string,
  ): Promise<{ isSmart: boolean; smartRuleId: string | null }> {
    const [builtIn, rule] = await Promise.all([
      this.smartAlbumRepository.getSmartBackedAlbumIds([albumId]),
      this.classificationRepository.getRuleByAlbumId(albumId),
    ]);
    return {
      isSmart: builtIn.has(albumId) || !!rule,
      smartRuleId: rule && rule.ownerId === auth.user.id ? rule.id : null,
    };
  }

  async getMapMarkers(auth: AuthDto, id: string, dto: AlbumMapMarkerDto = {}): Promise<MapMarkerResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [id] });

    if (auth.sharedLink && !auth.sharedLink.showExif) {
      return [];
    }

    // FL-51: the map settings sheet narrows a signed-in viewer's album map. A shared link acts as the
    // link's owner, so its visitors get the album's markers unfiltered: a favorites filter would
    // otherwise tell them which items the owner has favorited.
    // FL-54: markers are pure location, so an owner who hides their locations from the viewer contributes
    // none; a shared link is judged as the user who created it
    const hidden = await getLocationHiddenOwnerIdsForView({
      viewerId: auth.sharedLink?.userId ?? auth.user.id,
      albumIds: [id],
      repository: this.partnerRepository,
    });
    const locationHidden = hidden.size > 0 ? { locationHiddenOwnerIds: [...hidden] } : {};

    if (auth.sharedLink) {
      return this.mapRepository.getAlbumMapMarkers(id, { ...this.nsfwOptions(auth), ...locationHidden });
    }

    // As in the prototype's filterMapAssets, "Partner items" covers every item someone else owns, so
    // switching it off keeps only the viewer's own album items. "Shared spaces" only hides the viewer's
    // own items that reach them solely through a shared space, which an album's own markers never are,
    // so withSharedAlbums narrows nothing here.
    const { withPartners, withSharedAlbums: _withSharedAlbums, ...filters } = dto;
    const options: AlbumMapMarkerSearchOptions = { ...filters, favoriteOwnerId: auth.user.id };
    if (withPartners === false) {
      options.onlyOwnerId = auth.user.id;
    }

    return this.mapRepository.getAlbumMapMarkers(id, { ...this.nsfwOptions(auth), ...options, ...locationHidden });
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
    const coverAssetId = await this.firstCoverCandidate(auth, assetIds);

    const userMetadata = await this.userRepository.getMetadata(auth.user.id);

    // Nobody is put into a shared space without agreeing to it: the people named
    // at creation are invited, and become members only when they accept.
    const invitesOnly = kind === AlbumKind.Space;
    if (invitesOnly) {
      for (const { role } of albumUsers) {
        requireInvitableRole(role);
      }
    }

    const album = await this.albumRepository.create(
      {
        albumName: dto.albumName,
        description: dto.description,
        albumThumbnailAssetId: coverAssetId ?? null,
        order: getPreferences(userMetadata).albums.defaultAssetOrder,
        parentId: dto.parentId ?? null,
        icon: dto.icon ?? null,
        kind,
      },
      assetIds,
      invitesOnly
        ? [{ userId: auth.user.id, role: AlbumUserRole.Owner }]
        : [{ userId: auth.user.id, role: AlbumUserRole.Owner }, ...albumUsers],
      auth.user.id,
    );

    for (const { userId, role } of albumUsers) {
      if (invitesOnly) {
        await this.albumUserRepository.createInvite({
          albumId: album.id,
          userId,
          role,
          invitedById: auth.user.id,
        });
      }
      await this.eventRepository.emit('AlbumInvite', { id: album.id, userId, senderName: auth.user.name });
    }

    return mapAlbum(album);
  }

  async update(auth: AuthDto, id: string, dto: UpdateAlbumDto): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumUpdate, ids: [id] });

    const privacyOptions = this.nsfwOptions(auth);
    // Locked media is left out even for an elevated owner: a cover is seen by everyone the album is
    // shown to, so the candidates are the assets that every viewer may see.
    const album = await this.findOrFail(id, auth, { withAssets: true, lockedOwnerId: undefined });

    if (dto.albumThumbnailAssetId) {
      const visibleAssetIds = new Set(album.assets?.map((asset) => asset.id));
      if (!visibleAssetIds.has(dto.albumThumbnailAssetId)) {
        await this.requireNotOwnLockedCover(auth, dto.albumThumbnailAssetId);
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
    // FL-52: a move decided on an outdated directory is refused, not applied on top of the other move.
    if (dto.expectedParentId !== undefined && album.parentId !== dto.expectedParentId) {
      throw new ConflictException('The album was moved since the directory was loaded');
    }
    if (album.parentId !== dto.collectionId) {
      await this.validateAndReparent(auth, album, dto.collectionId, dto.expectedParentId);
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
    expectedParentId?: string | null,
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
    await (expectedParentId === undefined
      ? this.albumRepository.reparent(album.id, newParentId)
      : this.albumRepository.reparent(album.id, newParentId, expectedParentId));
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

    const newAssetIds = results.filter(({ success }) => success).map(({ id }) => id);
    // Putting an item in a rule's smart album by hand is a decision the rule keeps (FL-60).
    await this.classificationRepository.recordAlbumAdditions(id, newAssetIds, auth.user.id);
    if (newAssetIds.length > 0) {
      await this.albumRepository.update(
        id,
        {
          id,
          updatedAt: new Date(),
          albumThumbnailAssetId: album.albumThumbnailAssetId ?? (await this.firstCoverCandidate(auth, newAssetIds)),
        },
        auth.user.id,
      );

      const userIds = album.albumUsers.map(({ user }) => user.id);
      const recipientIds = userIds.filter((userId) => userId !== auth.user.id);
      await this.eventRepository.emit('AlbumUpdate', { id, userIds, recipientIds });
      await this.recordSpaceAssets(
        album,
        auth,
        SharedSpaceEventType.AssetsAdded,
        results.filter(({ success }) => success).map(({ id }) => id),
      );
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
    const spaceEvents: { album: MapAlbumDto; assetIds: string[] }[] = [];
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
          albumThumbnailAssetId:
            album.albumThumbnailAssetId ?? (await this.firstCoverCandidate(auth, notPresentAssetIds)),
        },
        auth.user.id,
      );
      const userIds = album.albumUsers.map(({ user }) => user.id);
      const recipientIds = userIds.filter((userId) => userId !== auth.user.id);
      events.push({ id: albumId, userIds, recipientIds });
      spaceEvents.push({ album, assetIds: notPresentAssetIds });
    }

    await this.albumRepository.addAssetIdsToAlbums(albumAssetValues);
    for (const albumId of allowedAlbumIds) {
      const added = albumAssetValues.filter((value) => value.albumId === albumId).map(({ assetId }) => assetId);
      await this.classificationRepository.recordAlbumAdditions(albumId, added, auth.user.id);
    }
    for (const event of events) {
      await this.eventRepository.emit('AlbumUpdate', event);
    }
    for (const { album, assetIds } of spaceEvents) {
      await this.recordSpaceAssets(album, auth, SharedSpaceEventType.AssetsAdded, assetIds);
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
    const isOwner = album.albumUsers.some(({ role, user }) => role === AlbumUserRole.Owner && user.id === auth.user.id);
    await this.recordSmartAlbumRemovals(id, removedIds, auth.user.id, isOwner);
    if (removedIds.length > 0) {
      if (album.albumThumbnailAssetId && removedIds.includes(album.albumThumbnailAssetId)) {
        await this.albumRepository.updateThumbnails();
      }

      await this.eventRepository.emit('AlbumUpdate', {
        id,
        userIds: album.albumUsers.map(({ user }) => user.id),
        recipientIds: [],
      });
      await this.recordSpaceAssets(album, auth, SharedSpaceEventType.AssetsRemoved, removedIds);
    }

    return results;
  }

  /**
   * Taking items out of a smart album by hand is a decision later evaluation keeps (FL-60): a rule's
   * match is rejected (and what the rule added besides the album is taken back), and a built-in smart
   * album excludes the item.
   */
  private async recordSmartAlbumRemovals(albumId: string, assetIds: string[], actorId: string, isOwner: boolean) {
    if (assetIds.length === 0) {
      return;
    }
    const outcome = await this.classificationRepository.recordAlbumRemovals(albumId, assetIds, actorId);
    for (const assetId of outcome.untagged) {
      await this.eventRepository.emit('AssetUntag', { assetId });
    }
    if (isOwner) {
      await this.smartAlbumRepository.excludeFromAlbum(albumId, assetIds);
    }
  }

  async addUsers(auth: AuthDto, id: string, { albumUsers }: AddUsersDto): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });

    const album = await this.findOrFail(id, auth, { withAssets: false });
    // Membership of a shared space belongs to its owner: an editor contributes
    // photos but never decides who is in the space. And a space is only entered
    // by accepting an invitation, so nobody is added to one here.
    const space = isSharedSpace(album);
    if (space) {
      requireSpaceOwner(album, auth.user.id);
    }

    for (const { userId, role } of albumUsers) {
      if (role === AlbumUserRole.Owner) {
        throw new BadRequestException('Cannot add another owner');
      }
      // The DTO leaves the role off for "share with edit rights", the album default.
      const invitedRole = role ?? AlbumUserRole.Editor;
      if (space) {
        requireInvitableRole(invitedRole);
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

      if (space) {
        await this.albumUserRepository.createInvite({
          albumId: id,
          userId,
          role: invitedRole,
          invitedById: auth.user.id,
        });
      } else {
        await this.albumUserRepository.create({ userId, albumId: id, role });
      }
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
    const space = isSharedSpace(album);

    const exists = album.albumUsers.find(({ user: { id } }) => id === userId);
    if (!exists) {
      // Someone who was invited to a shared space and never joined is withdrawn
      // through DELETE /shared-spaces/{id}/invitations/{userId}, not here.
      throw new BadRequestException('Album not shared with user');
    }

    if (
      exists.role === AlbumUserRole.Owner &&
      album.albumUsers.filter(({ role }) => role === AlbumUserRole.Owner).length === 1
    ) {
      throw new BadRequestException('Cannot remove the last album owner');
    }

    // Anyone can leave; removing somebody else needs share rights, and for a
    // shared space that means its owner.
    if (auth.user.id !== userId) {
      await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });
      if (space) {
        requireSpaceOwner(album, auth.user.id);
      }
    }

    await this.albumUserRepository.delete({ albumId: id, userId });
    this.sendAccessChange(album, userId, null);
    // FL-90: Studio work this member was doing through the album or space stops now.
    await this.eventRepository.emit('AlbumUserRemove', { albumId: id, userId });

    if (space) {
      // The feed says who left on their own and who was taken out (FL-55).
      await this.albumUserRepository.createSpaceEvent({
        albumId: id,
        actorId: auth.user.id,
        type: auth.user.id === userId ? SharedSpaceEventType.MemberLeft : SharedSpaceEventType.MemberRemoved,
        targetUserId: userId,
      });
    }
  }

  /**
   * Tell open pages at once that somebody's access to an album changed (FL-53): the person
   * concerned, so a downgraded or removed member loses controls and open dialogs without a reload,
   * and everyone else still in the album, so their member lists follow.
   */
  private sendAccessChange(
    album: { id: string; albumUsers: { user: { id: string } }[] },
    userId: string,
    role: AlbumUserRole | null,
  ) {
    const recipients = new Set([userId, ...album.albumUsers.map(({ user }) => user.id)]);
    for (const recipient of recipients) {
      this.websocketRepository.clientSend('AlbumUserUpdateV1', recipient, { albumId: album.id, userId, role });
    }
  }

  async updateUser(auth: AuthDto, id: string, userId: string, dto: UpdateAlbumUserDto): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });

    const album = await this.findOrFail(id, auth, { withAssets: false });
    const owner = album.albumUsers[0];

    if (owner.user.id === userId) {
      throw new BadRequestException('User is owner');
    }

    const space = isSharedSpace(album);
    if (space) {
      // Roles in a shared space are the owner's to set, and `owner` is not one
      // of them: a space has exactly one owner, the person who made it.
      requireSpaceOwner(album, auth.user.id);
      requireInvitableRole(dto.role);

      const invite = await this.albumUserRepository.getInvite({ albumId: id, userId });
      if (invite) {
        // The person has not joined yet, so the offer changes rather than a role.
        await this.albumUserRepository.createInvite({
          albumId: id,
          userId,
          role: dto.role,
          invitedById: invite.invitedById ?? auth.user.id,
        });
        return;
      }
    }

    await this.albumUserRepository.update({ albumId: id, userId }, { role: dto.role });
    this.sendAccessChange(album, userId, dto.role);

    if (space) {
      // Only a member's actual role change is news; a changed offer to somebody
      // who has not joined stays between the owner and the invitee.
      await this.albumUserRepository.createSpaceEvent({
        albumId: id,
        actorId: auth.user.id,
        type: SharedSpaceEventType.MemberRoleChanged,
        targetUserId: userId,
        subject: dto.role,
      });
    }
  }

  /**
   * Photos added to or removed from a shared space are entries in its activity
   * feed (FL-55). Ids only, recorded for every item whatever its visibility —
   * this is the backend's record of what happened, never a read of the asset,
   * so it needs no elevated session. Each member's view of it is filtered when
   * the feed is read.
   */
  private async recordSpaceAssets(
    album: MapAlbumDto,
    auth: AuthDto,
    type: SharedSpaceEventType.AssetsAdded | SharedSpaceEventType.AssetsRemoved,
    assetIds: string[],
  ) {
    if (!isSharedSpace(album) || assetIds.length === 0) {
      return;
    }

    await this.albumUserRepository.createSpaceEvent({ albumId: album.id, actorId: auth.user.id, type, assetIds });
  }

  /**
   * What this viewer may see of an album: the hidden-content filter, and — in an elevated session —
   * their own Locked media (`lockedOwnerId`). Locked media of other people never shows.
   */
  private nsfwOptions(auth: AuthDto, suppressedOnly?: boolean): AlbumReadOptions {
    return {
      ...(suppressedOnly ? getPrivacyQueryOptions(auth, true) : getHiddenContentQueryOptions(auth)),
      ...getLockedVisibilityOptions(auth),
    };
  }

  /**
   * Album covers are never Locked photos (owner decision, September 22, 2026, FL-53). Refuses a cover
   * that is the caller's own Locked photo with an error that says so. Anyone else's asset gets only the
   * generic error, so the answer never reveals whether another person's photo is Locked.
   */
  private async requireNotOwnLockedCover(auth: AuthDto, assetId: string): Promise<void> {
    const asset = await this.assetRepository.getById(assetId);
    if (asset && asset.ownerId === auth.user.id && isLockedRow(asset)) {
      throw new BadRequestException('A Locked photo cannot be an album cover');
    }
  }

  /**
   * The first of `assetIds` that may become the album cover. Only an elevated session can bring Locked
   * media into an album (see `Permission.AssetShare`), so only then can the first asset be unfit and
   * the choice needs the database; every other session keeps the first asset, as before.
   */
  private async firstCoverCandidate(auth: AuthDto, assetIds: string[]): Promise<string | undefined> {
    if (assetIds.length === 0) {
      return undefined;
    }

    if (!auth.session?.hasElevatedPermission) {
      return assetIds[0];
    }

    return this.albumRepository.getFirstCoverCandidate(assetIds);
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
    // The caller's explicit options win, so a read can leave the viewer's Locked media out on purpose.
    const album = await this.albumRepository.getById(id, { ...this.nsfwOptions(auth), ...options }, auth.user.id);
    if (!album) {
      throw new BadRequestException('Album not found');
    }
    return album;
  }
}
