import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { chunk } from 'lodash-es';
import type { Kysely } from 'kysely';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { SmartAlbumBuiltInKind } from 'src/dtos/system-config.dto.js';
import type { AlbumMapMarkerSearchOptions } from 'src/repositories/map.repository.js';
import type { DB } from 'src/schema/index.js';
import { ALBUM_ICON_GROUPS, MDI_ICON_CATALOGUE_VERSION, MDI_ICON_NAMES } from 'src/constants/album-icons.js';
import { OnEvent } from 'src/decorators.js';
import {
  AddUsersDto,
  AlbumDescendantCountResponseDto,
  AlbumHierarchyResponseDto,
  AlbumIconCatalogueResponseDto,
  AlbumOrderDto,
  AlbumResponseDto,
  AlbumStatisticsResponseDto,
  AlbumTreeResponseDto,
  AlbumViewDto,
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
import {
  AlbumKind,
  AlbumUserRole,
  FrameleafWorker,
  LibraryScope,
  Permission,
  PushEventType,
  SharedSpaceEventType,
  SystemMetadataKey,
} from 'src/enum.js';
import type { AlbumSummary } from 'src/repositories/album-summary.repository.js';
import { AlbumAssetCount, AlbumInfoOptions, AlbumReadOptions } from 'src/repositories/album.repository.js';
import { AlbumOriginField, AssetOriginField } from 'src/repositories/partner-origin.repository.js';
import { BaseService } from 'src/services/base.service.js';
import {
  getAlbumEditFields,
  queueAlbumCopies,
  recordAlbumEdit,
  recordAssetEdit,
} from 'src/services/partner-copy.service.js';
import { albumOrderGroup, buildAlbumHierarchy, buildAlbumTree, orderAlbumTree } from 'src/utils/album-tree.js';
import { albumViewerKey } from 'src/utils/album-viewer-key.js';
import { addAssets, removeAssets } from 'src/utils/asset.util.js';
import { asDateTimeString } from 'src/utils/date.js';
import {
  everyOwnersRules,
  getHiddenContentQueryOptions,
  getOthersRulesQueryOptions,
  getPrivacyQueryOptions,
} from 'src/utils/hidden-content.js';
import { scopeMatches } from 'src/utils/library-scope.js';
import { getLockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { isLockedRow } from 'src/utils/locked.js';
import { handlePromiseError } from 'src/utils/misc.js';
import { getPreferences } from 'src/utils/preferences.js';
import { isSharedSpace, requireInvitableRole, requireSpaceOwner, spaceOwnerId } from 'src/utils/shared-space.js';
import { getSupporters } from 'src/utils/supporter.js';

/** Why an editor's move is refused. The album's place is one stored value that everyone sees. */
export const ALBUM_MOVE_OWNER_ONLY =
  'Only the album owner can move it. Editors can change what is in the album, but not where it is kept.';

/** When each person's album covers were last repaired; see `refreshCoversInBackground`. */
const coverRefreshAt = new Map<string, number>();
/** People whose cover repair is still running: a slow one never overlaps the next. */
const coverRefreshRunning = new Set<string>();
const COVER_REFRESH_INTERVAL_MS = 60_000;

/** FL-1297: when each viewer variant's stored album numbers were last refreshed. */
const summaryRefreshAt = new Map<string, number>();
/** Viewer variants being refreshed now: requests never queue a second run behind the first. */
const summaryRefreshRunning = new Set<string>();
let summarySweepAt = 0;
const SUMMARY_REFRESH_INTERVAL_MS = 15_000;
/** Albums recomputed per query. Small enough that no single read of a large library is slow. */
const SUMMARY_REFRESH_CHUNK = 200;
/** Recomputed even with no change seen, for hiding rules that change no item. */
const SUMMARY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A change committed after a read started can carry an earlier time; look back far enough to catch it. */
const SUMMARY_CHANGE_MARGIN_MS = 2 * 60 * 1000;
/** A variant in use is recomputed daily, so a row this old belongs to one nobody reads any more. */
const SUMMARY_ABANDONED_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const millis = (value: Date | string) => new Date(value).getTime();

@Injectable()
export class AlbumService extends BaseService {
  /**
   * Repairs this person's album covers (gone, trashed or Locked items; "newest item" covers) without
   * holding up the album list. On a large library the repair rewrites every album and took seconds,
   * so a list may show a stale cover until the next load.
   * ponytail: in-process map, one entry per user; a write-time repair would make this unnecessary.
   */
  private refreshCoversInBackground(userId: string) {
    const now = Date.now();
    if (coverRefreshRunning.has(userId) || now - (coverRefreshAt.get(userId) ?? 0) < COVER_REFRESH_INTERVAL_MS) {
      return;
    }
    coverRefreshAt.set(userId, now);
    coverRefreshRunning.add(userId);
    const refresh = async () => {
      try {
        await this.albumRepository.updateThumbnails({ userId });
      } finally {
        coverRefreshRunning.delete(userId);
      }
    };
    handlePromiseError(refresh(), this.logger);
  }

  /**
   * FL-1297: the numbers an album list shows, read from the stored summaries of this viewer variant
   * (`albumViewerKey`), so listing never aggregates. An album with no row yet is reported as pending
   * and counted by the refresh this starts.
   */
  private async readStoredMetadata(albumIds: string[], options: AlbumReadOptions) {
    const viewerKey = albumViewerKey(options);
    const rows = await this.albumSummaryRepository.getByIds(viewerKey, albumIds);
    const stored = new Map(rows.map((row) => [row.albumId, row]));
    this.refreshSummariesInBackground(viewerKey, albumIds, options, stored);
    const metadata: Record<string, AlbumAssetCount> = {};
    for (const row of rows) {
      metadata[row.albumId] = row as AlbumAssetCount;
    }
    return { metadata, pending: new Set(albumIds.filter((id) => !stored.has(id))) };
  }

  /**
   * Recomputes only the summaries that need it, without holding up the list that noticed. The first
   * read of a large library starts it at once and the rows appear chunk by chunk.
   * ponytail: in-process maps, one entry per viewer variant; two API workers would only repeat the work.
   */
  private refreshSummariesInBackground(
    viewerKey: string,
    albumIds: string[],
    options: AlbumReadOptions,
    stored: Map<string, AlbumSummary>,
  ) {
    const now = Date.now();
    const recentlyRefreshed = now - (summaryRefreshAt.get(viewerKey) ?? 0) < SUMMARY_REFRESH_INTERVAL_MS;
    if (summaryRefreshRunning.has(viewerKey) || (stored.size === albumIds.length && recentlyRefreshed)) {
      return;
    }
    summaryRefreshAt.set(viewerKey, now);
    summaryRefreshRunning.add(viewerKey);
    const refresh = async () => {
      try {
        for (const ids of chunk(await this.summariesToRefresh(albumIds, stored, now), SUMMARY_REFRESH_CHUNK)) {
          // Taken before the read, so a change made while it runs still counts as newer than this row.
          const computedAt = new Date();
          const metadata = await this.albumRepository.getMetadataForIds(ids, options);
          await this.albumSummaryRepository.upsert(viewerKey, computedAt, ids, metadata);
        }
        if (now - summarySweepAt > SUMMARY_MAX_AGE_MS) {
          summarySweepAt = now;
          await this.albumSummaryRepository.deleteComputedBefore(new Date(now - SUMMARY_ABANDONED_AFTER_MS));
        }
      } finally {
        summaryRefreshRunning.delete(viewerKey);
      }
    };
    handlePromiseError(refresh(), this.logger);
  }

  /** Albums with no row, a row older than a day, or a change since their row was computed. */
  private async summariesToRefresh(albumIds: string[], stored: Map<string, AlbumSummary>, now: number) {
    const computedAt = new Map<string, number>();
    const due = new Set<string>();
    for (const id of albumIds) {
      const row = stored.get(id);
      if (row && now - millis(row.computedAt) < SUMMARY_MAX_AGE_MS) {
        computedAt.set(id, millis(row.computedAt));
      } else {
        due.add(id);
      }
    }
    if (computedAt.size > 0) {
      const since = new Date(Math.min(...computedAt.values()) - SUMMARY_CHANGE_MARGIN_MS);
      for (const { albumId, changedAt } of await this.albumSummaryRepository.getChangedAt(
        [...computedAt.keys()],
        since,
      )) {
        if (millis(changedAt) >= computedAt.get(albumId)! - SUMMARY_CHANGE_MARGIN_MS) {
          due.add(albumId);
        }
      }
    }
    return [...due];
  }

  async getStatistics(auth: AuthDto): Promise<AlbumStatisticsResponseDto> {
    const [owned, shared, notShared] = await Promise.all([
      this.albumRepository.getAll(auth.user.id, { isOwned: true, libraryScope: LibraryScope.Personal }),
      this.albumRepository.getAll(auth.user.id, { isShared: true, libraryScope: LibraryScope.Personal }),
      this.albumRepository.getAll(auth.user.id, {
        isOwned: true,
        isShared: false,
        libraryScope: LibraryScope.Personal,
      }),
    ]);

    return {
      owned: owned.length,
      shared: shared.length,
      notShared: notShared.length,
    };
  }

  async getAll(auth: AuthDto, { assetId, suppressedOnly, ...rest }: GetAlbumsDto): Promise<AlbumResponseDto[]> {
    this.refreshCoversInBackground(auth.user.id);

    const ownerId = auth.user.id;
    const privacyOptions = this.nsfwOptions(auth, suppressedOnly);
    // FL-522: a smart album the person hid stays out of their own album list (it keeps filling).
    // FL-647: left out in the query too, so a `take` limit counts only albums this list shows.
    const hidden = new Set(await this.smartAlbumRepository.getHiddenAlbumIds(ownerId));
    // Partner sharing: the album list leaves out partner albums when the account turned them off, in the
    // query so `take` counts only shown albums. The albums an item belongs to (`assetId`) always list them.
    if (!assetId && !getPreferences(await this.userRepository.getMetadata(ownerId)).albums.showPartnerAlbums) {
      for (const id of await this.partnerOriginRepository.getPartnerAlbumIds(ownerId)) {
        hidden.add(id);
      }
    }
    let albums: MapAlbumDto[] = assetId
      ? await this.albumRepository.getByAssetId(ownerId, assetId, privacyOptions)
      : await this.albumRepository.getAll(ownerId, {
          libraryScope: LibraryScope.Personal,
          ...rest,
          ...(hidden.size > 0 ? { excludeIds: [...hidden] } : {}),
        });
    if (hidden.size > 0) {
      albums = albums.filter((album) => !hidden.has(album.id));
    }

    // FL-326: the viewer's own albums copied from a partner name the library they came from
    const origins = await this.partnerOriginRepository.getOriginLabels(
      'album',
      albums.map((album) => album.id),
      ownerId,
    );

    if (albums.length === 0) {
      return [];
    }
    const albumIds = albums.map((album) => album.id);
    let albumMetadata: Record<string, AlbumAssetCount> = {};
    let pending = new Set<string>();
    if (privacyOptions.onlyHiddenContent) {
      // The hidden-content view needs a cover chosen from what it shows, which is not stored.
      for (const metadata of await this.albumRepository.getMetadataForIds(albumIds, privacyOptions)) {
        albumMetadata[metadata.albumId] = metadata;
      }
    } else {
      ({ metadata: albumMetadata, pending } = await this.readStoredMetadata(albumIds, privacyOptions));
    }
    albums = await this.hideNsfwAlbumThumbnails(auth, albums, privacyOptions, albumMetadata);

    const readable = await this.readableParents(auth, albums);
    return this.withSupporters(
      auth,
      albums.map((album) => {
        const item = this.withReadableParent(this.toListItem(album, albumMetadata, pending), readable);
        const origin = origins.get(album.id);
        return origin ? { ...item, origin } : item;
      }),
    );
  }

  /** Supporter option (b): mark the members who are supporters. A shared-link visitor is not told. */
  private async withSupporters(auth: AuthDto, albums: AlbumResponseDto[]): Promise<AlbumResponseDto[]> {
    if (auth.sharedLink || albums.length === 0) {
      return albums;
    }
    const isSupporter = await getSupporters(
      {
        systemMetadataRepository: this.systemMetadataRepository,
        frameleafUserLicenseRepository: this.frameleafUserLicenseRepository,
      },
      albums.flatMap(({ albumUsers }) => albumUsers.map(({ user }) => user.id)),
    );
    return albums.map((album) => ({
      ...album,
      albumUsers: album.albumUsers.map((member) => ({ ...member, supporter: isSupporter(member.user.id) })),
    }));
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
  async getTree(auth: AuthDto, dto: AlbumViewDto = {}): Promise<AlbumTreeResponseDto> {
    const { tree } = await this.loadDirectory(auth, dto);
    return tree;
  }

  private async loadDirectory(
    auth: AuthDto,
    dto: AlbumViewDto,
  ): Promise<{ tree: AlbumTreeResponseDto; positions: Map<string, number> }> {
    this.refreshCoversInBackground(auth.user.id);

    const privacyOptions = this.nsfwOptions(auth);
    let albums: MapAlbumDto[] = await this.albumRepository.getAll(auth.user.id, {
      libraryScope: dto.libraryScope ?? LibraryScope.Personal,
    });
    if (albums.length === 0) {
      return { tree: buildAlbumTree([]), positions: new Map() };
    }

    const ids = albums.map((album) => album.id);
    const [stored, smartBackedIds, ruleAlbumIds, rules, positions, recovered, bookmarkCounts] = await Promise.all([
      this.readStoredMetadata(ids, privacyOptions),
      this.smartAlbumRepository.getSmartBackedAlbumKinds(ids),
      this.classificationRepository.getRuleAlbumIds(ids),
      this.classificationRepository.getRules(auth.user.id),
      this.albumRepository.getPositions(auth.user.id),
      this.recoveredAlbumIds(),
      this.albumRepository.getBookmarkCounts(auth, ids),
    ]);
    const ruleByAlbum = new Map(rules.map((rule) => [rule.albumId, rule.id]));
    const { metadata: albumMetadata, pending } = stored;
    albums = await this.hideNsfwAlbumThumbnails(auth, albums, privacyOptions, albumMetadata);

    // Every group comes back in the person's own custom order (FL-52); the client's "Custom order"
    // sort shows it as is, the other sorts re-sort it.
    const readable = await this.readableParents(auth, albums);
    const tree = orderAlbumTree(
      buildAlbumTree(
        albums.map((album) => ({
          ...this.withReadableParent(this.toListItem(album, albumMetadata, pending), readable),
          bookmarkCount: bookmarkCounts.get(album.id) ?? 0,
          isSmart: smartBackedIds.has(album.id) || ruleAlbumIds.has(album.id),
          smartRuleId: ruleByAlbum.get(album.id) ?? null,
          smartKind: (smartBackedIds.get(album.id) as SmartAlbumBuiltInKind | undefined) ?? null,
          ...(recovered.has(album.id) && { recovered: true }),
        })),
      ),
      positions,
    );
    return { tree, positions };
  }

  async getHierarchy(auth: AuthDto, dto: AlbumViewDto = {}): Promise<AlbumHierarchyResponseDto> {
    const { tree, positions } = await this.loadDirectory(auth, dto);
    return buildAlbumHierarchy(
      [
        ...tree.collections.flatMap(({ collection, albums }) => [collection, ...albums]),
        ...tree.albums,
        ...tree.spaces,
      ],
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
    await this.albumRepository.setPositions(auth.user.id, albumIds, (rows) => {
      const view = dto.libraryScope ?? LibraryScope.Personal;
      const visible = rows.filter(
        ({ libraryScope, role }) =>
          scopeMatches(libraryScope ?? LibraryScope.Personal, view) ||
          (view === LibraryScope.Personal && role !== undefined && role !== AlbumUserRole.Owner),
      );
      const group = albumOrderGroup(visible, dto.parentId, albumIds[0], dto.hierarchy);
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

  private toListItem(
    album: MapAlbumDto,
    albumMetadata: Record<string, AlbumAssetCount>,
    pending: Set<string>,
  ): AlbumResponseDto {
    return {
      ...mapAlbum(album),
      startDate: asDateTimeString(albumMetadata[album.id]?.startDate ?? undefined),
      endDate: asDateTimeString(albumMetadata[album.id]?.endDate ?? undefined),
      assetCount: albumMetadata[album.id]?.assetCount ?? 0,
      // lastModifiedAssetTimestamp is only used in mobile app, please remove if not need
      lastModifiedAssetTimestamp: asDateTimeString(albumMetadata[album.id]?.lastModifiedAssetTimestamp ?? undefined),
      ...(pending.has(album.id) && { statsPending: true }),
    };
  }

  /**
   * FL-416: the "Recovered Media" albums the identical-files run made, one per owner, with files Immich had
   * lost track of. Remembered by id, so a renamed album keeps its cover mark.
   */
  private async recoveredAlbumIds(): Promise<Set<string>> {
    const state = await this.systemMetadataRepository.get(SystemMetadataKey.IdenticalFiles);
    return new Set(Object.values(state?.recoveredAlbums ?? {}));
  }

  /** FL-326: the partner library the viewer's own album was copied from; never shown through a shared link. */
  private async originOf(auth: AuthDto, albumId: string) {
    if (auth.sharedLink) {
      return {};
    }
    const labels = await this.partnerOriginRepository.getOriginLabels('album', [albumId], auth.user.id);
    const origin = labels.get(albumId);
    return origin ? { origin } : {};
  }

  async get(auth: AuthDto, id: string, { suppressedOnly }: GetAlbumInfoDto = {}): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [id] });
    await this.albumRepository.updateThumbnails([id]);
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
    const [withSupporters] = await this.withSupporters(auth, [mapAlbum(mappedAlbum)]);
    // FL-83: a shared link's visitors learn a member's display name and avatar, never an email, just
    // as they are told nothing but the link owner's name
    const response = auth.sharedLink
      ? {
          ...withSupporters,
          albumUsers: withSupporters.albumUsers.map((member) => ({ ...member, user: { ...member.user, email: '' } })),
        }
      : withSupporters;
    return {
      ...this.withReadableParent(response, readable),
      startDate: asDateTimeString(albumMetadataForIds?.startDate ?? undefined),
      endDate: asDateTimeString(albumMetadataForIds?.endDate ?? undefined),
      assetCount: albumMetadataForIds?.assetCount ?? 0,
      lastModifiedAssetTimestamp: asDateTimeString(albumMetadataForIds?.lastModifiedAssetTimestamp ?? undefined),
      contributorCounts: isShared
        ? await this.albumRepository.getContributorCounts(album.id, privacyOptions)
        : undefined,
      coverFollowsNewest: (await this.albumRepository.isCoverFollowingNewest(album.id)) === true,
      ...(await this.smartStateOf(auth, album.id)),
      ...(await this.originOf(auth, album.id)),
      ...((await this.recoveredAlbumIds()).has(album.id) && { recovered: true }),
    };
  }

  /**
   * Whether an album is filled automatically (FL-60): a built-in smart album, or one of the viewer's
   * own classification rules. Another person's rule id is never returned.
   */
  private async smartStateOf(
    auth: AuthDto,
    albumId: string,
  ): Promise<{ isSmart: boolean; smartRuleId: string | null; smartKind: SmartAlbumBuiltInKind | null }> {
    const [builtIn, rule] = await Promise.all([
      this.smartAlbumRepository.getSmartBackedAlbumKinds([albumId]),
      this.classificationRepository.getRuleByAlbumId(albumId),
    ]);
    return {
      isSmart: builtIn.has(albumId) || !!rule,
      smartRuleId: rule && rule.ownerId === auth.user.id ? rule.id : null,
      smartKind: (builtIn.get(albumId) as SmartAlbumBuiltInKind | undefined) ?? null,
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
    if (auth.sharedLink) {
      return this.mapRepository.getAlbumMapMarkers(id, this.nsfwOptions(auth));
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

    return this.mapRepository.getAlbumMapMarkers(id, { ...this.nsfwOptions(auth), ...options });
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
      if (kind === AlbumKind.Space) {
        throw new BadRequestException('Shared spaces stay at the top level');
      }
      // Nesting changes the collection, so require AlbumUpdate on it (owner or editor).
      await this.requireAccess({ auth, permission: Permission.AlbumUpdate, ids: [dto.parentId] });
      await this.requireParentAlbum(auth, dto.parentId);
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
        libraryScope: dto.libraryScope ?? LibraryScope.Personal,
        albumName: dto.albumName,
        description: dto.description,
        albumThumbnailAssetId: coverAssetId ?? null,
        order: getPreferences(userMetadata).albums.defaultAssetOrder,
        parentId: dto.parentId ?? null,
        icon: dto.icon ?? null,
        color: dto.color ?? null,
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

    // FL-326 (spec §4.4): a plain album goes to everyone its owner shares their library with
    if (kind === AlbumKind.Album) {
      await queueAlbumCopies({ partner: this.partnerRepository, job: this.jobRepository }, auth.user.id, album.id);
    }

    return mapAlbum(album);
  }

  async update(auth: AuthDto, id: string, dto: UpdateAlbumDto): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumUpdate, ids: [id] });

    const privacyOptions = this.nsfwOptions(auth);
    // Locked media is left out even for an elevated owner: a cover is seen by everyone the album is
    // shown to, so the candidates are the assets that every viewer may see.
    const album = await this.findOrFail(id, auth, { withAssets: true, lockedOwnerId: undefined });

    if (dto.libraryScope !== undefined && spaceOwnerId(album) !== auth.user.id) {
      throw new ForbiddenException('Only the album owner can change its library scope');
    }

    if (dto.isLocked !== undefined && spaceOwnerId(album) !== auth.user.id) {
      throw new ForbiddenException('Only the album owner can lock or unlock it');
    }

    if (dto.albumThumbnailAssetId && dto.coverFollowsNewest) {
      throw new BadRequestException('Pick a cover or follow the newest item, not both');
    }

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

    // FL-83 (AL-13): picking a specific item stops the cover following the newest item. Saved before
    // the album row is written and read back, so turning it on returns the newest item as the cover.
    const coverFollowsNewest = dto.albumThumbnailAssetId ? false : dto.coverFollowsNewest;
    const fields = getAlbumEditFields(dto);
    const updatedAlbum = await this.partnerOriginRepository.withOriginEdit('album', [album.id], fields, async () => {
      if (coverFollowsNewest !== undefined) {
        await this.albumRepository.setCoverFollowsNewest(album.id, coverFollowsNewest);
      }
      return this.albumRepository.update(
        album.id,
        {
          id: album.id,
          libraryScope: dto.libraryScope,
          albumName: dto.albumName,
          description: dto.description,
          albumThumbnailAssetId: dto.albumThumbnailAssetId,
          isActivityEnabled: dto.isActivityEnabled,
          isLocked: dto.isLocked,
          order: dto.order,
          icon: dto.icon,
          color: dto.color,
          sortOrder: dto.sortOrder,
        },
        auth.user.id,
      );
    });

    // FL-326: an album copy's edited fields are its own from now on; copies of this album follow it
    await recordAlbumEdit({ partnerOrigin: this.partnerOriginRepository, job: this.jobRepository }, [album.id], fields);

    // Unlocking the album only stops new items locking; what it locked stays locked. While the album is
    // locked, the hourly sweep re-locks an item unlocked on its own (owner decision default, FL-1269).
    if (dto.isLocked) {
      await this.lockAlbumItems({ albumId: album.id });
    }

    // Members' open pages re-read the album (its shared order, name, cover); no email for an edit.
    await this.eventRepository.emit('AlbumUpdate', {
      id: album.id,
      userIds: album.albumUsers.map(({ user }) => user.id),
      recipientIds: [],
    });

    const [mappedAlbum] = await this.hideNsfwAlbumThumbnails(
      auth,
      [{ ...updatedAlbum, assets: album.assets }],
      privacyOptions,
    );
    return {
      ...mapAlbum(mappedAlbum),
      coverFollowsNewest: coverFollowsNewest ?? (await this.albumRepository.isCoverFollowingNewest(album.id)) === true,
    };
  }

  /**
   * A locked album locks its owner's photos and videos in it, as the owner's own lock, so they are sealed too
   * when the owner's Locked encryption is on. Other people's items in a shared album are theirs to lock and stay
   * as they are. Narrowed to one album and to some items when given.
   */
  private async lockAlbumItems(filter: { albumId?: string; assetIds?: string[] }): Promise<void> {
    const { assetIds } = filter;
    if (assetIds?.length === 0) return;
    // One bind parameter per id: stay far below PostgreSQL's 65,535 for very large adds.
    const items = assetIds
      ? (
          await Promise.all(
            chunk(assetIds, 10_000).map((ids) =>
              this.albumRepository.getUnlockedItemsInLockedAlbums({ ...filter, assetIds: ids }),
            ),
          )
        ).flat()
      : await this.albumRepository.getUnlockedItemsInLockedAlbums(filter);
    // Locking reads every id back (lock groups, partner origins): batch it too, trying each batch.
    let firstError: unknown;
    for (const batch of chunk(items, 10_000)) {
      try {
        await this.lockItems(batch);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  }

  /** Every owner is tried; one owner's failure (a lock group changing meanwhile) doesn't hold back the rest. */
  private async lockItems(items: { assetId: string; ownerId: string }[]): Promise<void> {
    const failures: unknown[] = [];
    for (const [ownerId, owned] of Map.groupBy(items, ({ ownerId }) => ownerId)) {
      try {
        await this.lockAssetsAs(
          ownerId,
          owned.map(({ assetId }) => assetId),
          (visibilityIds) =>
            recordAssetEdit(
              { partnerOrigin: this.partnerOriginRepository, job: this.jobRepository },
              ownerId,
              visibilityIds,
              [AssetOriginField.Visibility],
            ),
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw failures[0];
  }

  /**
   * An add never stops half-way because its lock failed: the items are already in the album, so the add's
   * own follow-up (covers, notifications, other albums) still runs, from what is actually locked, and the
   * hourly sweep locks what this missed.
   */
  private async lockAddedItems(albumId: string, assetIds: string[]): Promise<void> {
    try {
      await this.lockAlbumItems({ albumId, assetIds });
    } catch (error) {
      // The sweep retries items left unlocked; a failure after the lock committed already recorded the edit.
      this.logger.warn(`Could not finish locking items added to locked album ${albumId}: ${error}`);
    }
  }

  /**
   * Hourly: locks what a locked album still holds unlocked. Items reach albums in ways that don't lock
   * them at once (smart-album rules, iCloud album sync, capture), and an add whose lock failed leaves
   * its items in the album; this catches them all.
   */
  @OnEvent({ name: 'AppBootstrap', workers: [FrameleafWorker.Microservices] })
  onBootstrapLockedAlbums(): void {
    this.cronRepository.create({
      name: 'lockedAlbumSweep',
      expression: '23 * * * *',
      onTick: () => handlePromiseError(this.lockStrayAlbumItems(), this.logger),
      start: true,
    });
  }

  async lockStrayAlbumItems(): Promise<void> {
    // ponytail: batches of 1000, at most 100 per pass; whatever is left waits for the next hour
    // Pages by item id, so items that fail to lock never hold back the ones after them.
    let afterAssetId: string | undefined;
    let firstError: unknown;
    for (let pass = 0; pass < 100; pass++) {
      const batch = await this.albumRepository.getUnlockedItemsInLockedAlbums({ afterAssetId, limit: 1000 });
      try {
        await this.lockItems(batch);
      } catch (error) {
        firstError ??= error;
      }
      if (batch.length < 1000) break;
      afterAssetId = batch.at(-1)!.assetId;
    }
    if (firstError) throw firstError;
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
   * Albums and collections may nest; only their owner reorganises them (parentId is a single stored value, so an editor
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

    if (asAlbumKind(album.kind) === AlbumKind.Space) {
      throw new BadRequestException('Shared spaces stay at the top level');
    }

    const owner = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner);
    if (owner?.user.id !== auth.user.id) {
      // FL-83 (AL-9, owner decision 2026-09-27): editors never move albums, by Move to… or by dragging.
      throw new ForbiddenException(ALBUM_MOVE_OWNER_ONLY);
    }

    if (newParentId !== null) {
      await this.requireAccess({ auth, permission: Permission.AlbumUpdate, ids: [newParentId] });
      await this.requireParentAlbum(auth, newParentId);
    }

    // The descendant/cycle check runs inside reparent's transaction (atomic with
    // the parent update) to avoid a TOCTOU race between concurrent reparents.
    await (expectedParentId === undefined
      ? this.albumRepository.reparent(album.id, newParentId)
      : this.albumRepository.reparent(album.id, newParentId, expectedParentId));
  }

  private async requireParentAlbum(auth: AuthDto, id: string): Promise<void> {
    const parent = await this.findOrFail(id, auth, { withAssets: false });
    if (asAlbumKind(parent.kind) === AlbumKind.Space) {
      throw new BadRequestException('Albums cannot nest inside a shared space');
    }
  }

  /**
   * Deleting a node promotes its children in one transaction; original media
   * and descendant albums are preserved.
   */
  async delete(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AlbumDelete, ids: [id] });
    await this.findOrFail(id, auth, { withAssets: false });
    await this.albumRepository.deleteCollection(id);
  }

  async addAssets(auth: AuthDto, id: string, dto: BulkIdsDto, sourceLinkId?: string): Promise<BulkIdResponseDto[]> {
    const album = await this.findOrFail(id, auth, { withAssets: false });
    await this.requireAccess({ auth, permission: Permission.AlbumAssetCreate, ids: [id] });

    const { results, response } = await this.partnerOriginRepository.withOriginEdit('album', [id], [], () =>
      this.albumRepository.withMembershipWrite([id], async (tx, bulk) => {
        if (sourceLinkId) {
          await this.requireSourceLink(tx, auth, id, sourceLinkId);
        }
        const recorded = sourceLinkId
          ? await this.albumSourceRepository.getRecordedAssetIds(tx, id, dto.ids)
          : new Set<string>();
        let inserted: Set<string> | undefined;
        const sourceBulk = sourceLinkId
          ? {
              getAssetIds: bulk.getAssetIds.bind(bulk),
              removeAssetIds: bulk.removeAssetIds.bind(bulk),
              addAssetIds: async (albumId: string, assetIds: string[]) => {
                const memberships = await bulk.addAssetIdsReturning(albumId, assetIds);
                inserted = new Set(memberships.map(({ assetId }) => assetId));
              },
            }
          : bulk;
        const attempted = await addAssets(
          auth,
          { access: this.accessRepository, bulk: sourceBulk },
          { parentId: id, assetIds: dto.ids, permission: Permission.AssetShare },
        );
        // An unfenced writer may win an absent-row insert after the utility's read. That is a
        // duplicate, not source ownership, and must not produce addition events or follow-up jobs.
        const results = attempted.map((result) =>
          result.success && inserted && !inserted.has(result.id)
            ? { id: result.id, success: false, error: BulkIdErrorReason.DUPLICATE }
            : result,
        );
        const syncOwned = results.filter(
          ({ success, error, id }) => !success && error === BulkIdErrorReason.DUPLICATE && recorded.has(id),
        );
        if (sourceLinkId) {
          await this.albumSourceRepository.record(
            tx,
            sourceLinkId,
            [...results.filter(({ success }) => success), ...syncOwned].map(({ id }) => id),
          );
        }
        if (results.some(({ success }) => success)) {
          await this.partnerOriginRepository.markOverridden('album', [id], [AlbumOriginField.Membership]);
        }
        const owned = new Set(syncOwned.map(({ id }) => id));
        return {
          results,
          response: results.map((result) => (owned.has(result.id) ? { id: result.id, success: true } : result)),
        };
      }),
    );

    const newAssetIds = results.filter(({ success }) => success).map(({ id }) => id);
    // Reads the lock as it is after the write, so an add racing a lock still locks its items.
    await this.lockAddedItems(id, newAssetIds);
    await this.emitAssetsChanged(newAssetIds);
    // Putting an item in a rule's smart album by hand is a decision the rule keeps (FL-60).
    await this.classificationRepository.recordAlbumAdditions(id, newAssetIds, auth.user.id);
    if (newAssetIds.length > 0) {
      const shown = await this.shownToMembers(newAssetIds);
      if (shown.length > 0) {
        await this.albumRepository.update(
          id,
          {
            id,
            updatedAt: new Date(),
            albumThumbnailAssetId: album.albumThumbnailAssetId ?? (await this.firstCoverCandidate(auth, shown)),
          },
          auth.user.id,
        );
      }
      // An album whose cover follows the newest item takes the newest of what was just added (FL-83).
      await this.albumRepository.updateNewestCovers([id]);

      await this.eventRepository.emit('AlbumUpdate', this.albumUpdateEvent(album, auth, shown.length > 0));
      await this.recordSpaceAssets(
        album,
        auth,
        SharedSpaceEventType.AssetsAdded,
        results.filter(({ success }) => success).map(({ id }) => id),
      );
      // FL-326 (spec §4.4): membership changed by hand stops a copy following; copies of this album follow
      await recordAlbumEdit(
        { partnerOrigin: this.partnerOriginRepository, job: this.jobRepository },
        [id],
        [AlbumOriginField.Membership],
      );
    }

    return response;
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
    const added: { albumId: string; album: Awaited<ReturnType<AlbumService['findOrFail']>>; assetIds: string[] }[] = [];
    await this.partnerOriginRepository.withOriginEdit('album', [...allowedAlbumIds], [], async () => {
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
        added.push({ albumId, album, assetIds: notPresentAssetIds });
      }

      await this.albumRepository.addAssetIdsToAlbums(albumAssetValues);
      await this.partnerOriginRepository.markOverridden(
        'album',
        added.map(({ albumId }) => albumId),
        [AlbumOriginField.Membership],
      );
    });

    // A locked album locks what it was given before anything decides what members see: covers and
    // notifications only ever come from items still shown to them.
    const events: { id: string; userIds: string[]; recipientIds: string[] }[] = [];
    for (const { albumId, album, assetIds } of added) {
      await this.lockAddedItems(albumId, assetIds);
      const shown = await this.shownToMembers(assetIds);
      if (shown.length > 0) {
        await this.albumRepository.update(
          albumId,
          {
            id: albumId,
            updatedAt: new Date(),
            albumThumbnailAssetId: album.albumThumbnailAssetId ?? (await this.firstCoverCandidate(auth, shown)),
          },
          auth.user.id,
        );
      }
      events.push(this.albumUpdateEvent(album, auth, shown.length > 0));
    }
    if (events.length > 0) {
      await this.albumRepository.updateNewestCovers(events.map(({ id }) => id));
    }
    for (const { albumId, assetIds } of added) {
      await this.classificationRepository.recordAlbumAdditions(albumId, assetIds, auth.user.id);
    }
    await this.emitAssetsChanged(albumAssetValues.map((item) => item.assetId));
    for (const event of events) {
      await this.eventRepository.emit('AlbumUpdate', event);
    }
    for (const { album, assetIds } of added) {
      await this.recordSpaceAssets(album, auth, SharedSpaceEventType.AssetsAdded, assetIds);
    }
    // FL-326 (spec §4.4): membership changed by hand stops a copy following; copies of these albums follow
    await recordAlbumEdit(
      { partnerOrigin: this.partnerOriginRepository, job: this.jobRepository },
      events.map(({ id }) => id),
      [AlbumOriginField.Membership],
    );

    return results;
  }

  async removeAssets(auth: AuthDto, id: string, dto: BulkIdsDto, sourceLinkId?: string): Promise<BulkIdResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AlbumAssetDelete, ids: [id] });

    const album = await this.findOrFail(id, auth, { withAssets: false });
    const { results, response } = await this.partnerOriginRepository.withOriginEdit('album', [id], [], () =>
      this.albumRepository.withMembershipWrite([id], async (tx, bulk) => {
        let ids = dto.ids;
        let mine: Set<string> | undefined;
        if (sourceLinkId) {
          await this.requireSourceLink(tx, auth, id, sourceLinkId);
          mine = await this.albumSourceRepository.getRecordedAssetIds(tx, id, ids, sourceLinkId);
          // Drop this link's claim first, then see whether another link still owns the same generation.
          await this.albumSourceRepository.unrecord(tx, sourceLinkId, [...mine]);
          const held = await this.albumSourceRepository.getRecordedAssetIds(tx, id, [...mine]);
          ids = [...mine.difference(held)];
        }
        const results = await removeAssets(
          auth,
          { access: this.accessRepository, bulk },
          { parentId: id, assetIds: ids, canAlwaysRemove: Permission.AlbumDelete },
        );
        // A refused removal must keep its claim so a later authorized attempt can remove it.
        if (sourceLinkId) {
          await this.albumSourceRepository.record(
            tx,
            sourceLinkId,
            results
              .filter(({ success, error }) => !success && error === BulkIdErrorReason.NO_PERMISSION)
              .map(({ id }) => id),
          );
        }
        if (results.some(({ success }) => success)) {
          await this.partnerOriginRepository.markOverridden('album', [id], [AlbumOriginField.Membership]);
        }
        const failures = new Map(results.filter(({ success }) => !success).map((result) => [result.id, result]));
        const response = mine
          ? dto.ids.map((assetId) => {
              const failure = failures.get(assetId);
              if (failure) {
                return failure;
              }
              return mine.has(assetId)
                ? { id: assetId, success: true }
                : { id: assetId, success: false, error: BulkIdErrorReason.NOT_FOUND };
            })
          : results;
        return { results, response };
      }),
    );

    const removedIds = results.filter(({ success }) => success).map(({ id }) => id);
    await this.emitAssetsChanged(removedIds);
    const isOwner = album.albumUsers.some(({ role, user }) => role === AlbumUserRole.Owner && user.id === auth.user.id);
    await this.recordSmartAlbumRemovals(id, removedIds, auth.user.id, isOwner);
    if (removedIds.length > 0) {
      if (album.albumThumbnailAssetId && removedIds.includes(album.albumThumbnailAssetId)) {
        await this.albumRepository.updateThumbnails([id]);
      }

      await this.eventRepository.emit('AlbumUpdate', {
        id,
        userIds: album.albumUsers.map(({ user }) => user.id),
        recipientIds: [],
      });
      await this.recordSpaceAssets(album, auth, SharedSpaceEventType.AssetsRemoved, removedIds);
      // FL-326 (spec §4.4): membership changed by hand stops a copy following; copies of this album follow
      await recordAlbumEdit(
        { partnerOrigin: this.partnerOriginRepository, job: this.jobRepository },
        [id],
        [AlbumOriginField.Membership],
      );
    }

    return response;
  }

  /** Source ownership is revalidated after acquiring the ordinary membership fence. */
  private async requireSourceLink(tx: Kysely<DB>, auth: AuthDto, albumId: string, linkId: string) {
    const link = await this.albumSourceRepository.get(tx, auth.user.id, linkId);
    if (!link || link.albumName === null || link.albumId !== albumId) {
      throw new NotFoundException('Album source link not found');
    }
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
    await this.eventRepository.emit('AlbumUserRemove', { albumId: id, userId, removedById: auth.user.id });

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

    if (album.albumUsers.every(({ user }) => user.id !== userId)) {
      throw new BadRequestException('Album not shared with user');
    }

    await this.albumUserRepository.update({ albumId: id, userId }, { role: dto.role });
    this.sendAccessChange(album, userId, dto.role);
    // FL-228: the member's access changed
    await this.eventRepository.emit('PushNotify', {
      type: PushEventType.AccessChanged,
      userIds: [userId],
      title: 'Access changed',
      body: `Your role in ${album.albumName} is now ${dto.role}`,
      systemTemplate: { version: 1, key: `album-role-${dto.role}`, args: { albumName: album.albumName } },
      data: { albumId: id, change: 'role', role: dto.role },
    });

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
  /**
   * FL-137: what of these new album items other members can see. Locked media never reaches anyone but
   * its owner, nor does an item matching its owner's Locked rules (FL-446), so an addition of such items
   * only must not tell members that anything changed.
   */
  private async shownToMembers(assetIds: string[]): Promise<string[]> {
    const [locked, ruleHidden] = await Promise.all([
      this.assetRepository.getLockedAssetIds(assetIds),
      this.assetRepository.getHiddenContentAssetIds(assetIds, everyOwnersRules),
    ]);
    return assetIds.filter((assetId) => !locked.has(assetId) && !ruleHidden.has(assetId));
  }

  /**
   * The album refresh and "album updated" notification for an addition. When members can see nothing
   * of it, only the actor's own sessions refresh and nobody is notified.
   */
  private albumUpdateEvent(
    album: { id: string; albumUsers: Array<{ user: { id: string } }> },
    auth: AuthDto,
    visibleToMembers: boolean,
  ) {
    if (!visibleToMembers) {
      return { id: album.id, userIds: [auth.user.id], recipientIds: [] };
    }
    const userIds = album.albumUsers.map(({ user }) => user.id);
    return { id: album.id, userIds, recipientIds: userIds.filter((userId) => userId !== auth.user.id) };
  }

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
   * their own Locked media (`lockedOwnerId`). Locked media of other people never shows, nor does
   * another member's item that matches its owner's Locked rules (FL-446: partners only).
   */
  private nsfwOptions(auth: AuthDto, suppressedOnly?: boolean): AlbumReadOptions {
    return {
      ...(suppressedOnly ? getPrivacyQueryOptions(auth, true) : getHiddenContentQueryOptions(auth)),
      ...getLockedVisibilityOptions(auth),
      ...getOthersRulesQueryOptions(auth),
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
   * The first of `assetIds` that may become the album cover. Callers pass only items shown to members
   * (`shownToMembers`, read after a locked album has locked its additions). Only an elevated session can
   * bring other Locked media into an album (see `Permission.AssetShare`), so only then does the choice
   * still need the database; every other session keeps the first asset, as before.
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

    // FL-446: a cover another member owns is also left out when it matches that owner's Locked rules
    if (
      !options.excludeNsfw &&
      !options.hiddenContent &&
      !options.onlyHiddenContent &&
      options.othersRulesViewerId === undefined
    ) {
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
