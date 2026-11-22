import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import z from 'zod';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { HouseholdShareInviteDto, HouseholdShareLinkDto } from 'src/dtos/household-share.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { HouseholdPeerAccess } from 'src/services/household-peer.service.js';
import { OnEvent } from 'src/decorators.js';
import { CacheControl, Permission } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { HouseholdLinkRepository } from 'src/repositories/household-link.repository.js';
import { HouseholdShareRepository } from 'src/repositories/household-share.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { RateLimitRepository } from 'src/repositories/rate-limit.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { HouseholdLinkService } from 'src/services/household-link.service.js';
import { HouseholdPeerService } from 'src/services/household-peer.service.js';
import { SPACE_CONTENT_OPTIONS } from 'src/services/shared-space.service.js';
import { requireAccess } from 'src/utils/access.js';
import { FileDownloadResponse } from 'src/utils/file.js';
import {
  HOUSEHOLD_DOWNLOAD_SECONDS,
  isHouseholdDownloadValid,
  signHouseholdDownload,
} from 'src/utils/household-protocol.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { getPreferences } from 'src/utils/preferences.js';
import { requireSharedSpace, requireSpaceOwner, spaceOwnerId } from 'src/utils/shared-space.js';

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;
const PAGE_ENTRIES = 200;
/** Design section 8, less room for the envelope around the entries. */
const PAGE_BYTES = 2 * 1024 * 1024 - 4096;
const DIRECTORY_CACHE_MS = 5 * 60_000;
const MAX_AVATAR_BYTES = 1024 * 1024;
const STREAMS_PER_LINK = 2;
const POKES_PER_MINUTE = 1;

const Directory = z
  .array(z.strictObject({ id: z.uuid(), name: z.string().max(100), hasAvatar: z.boolean() }))
  .max(1000);
type DirectoryEntry = z.infer<typeof Directory>[number];

const refused = () => new ForbiddenException();
const iso = (value: Date | string) => new Date(value).toISOString();
/** A display name can hold an address (an account named after its email): that never crosses. */
const peerName = (name: string) => (name.includes('@') ? 'Member' : name.slice(0, 100));
const memberState = (member: { acceptedAt: unknown; leftAt: unknown }) =>
  member.leftAt ? 'left' : member.acceptedAt ? 'accepted' : 'invited';

type ManifestEntry = { seq: number; kind: string; id: string } & (
  | { stop: true }
  | { asset: Record<string, unknown> }
  | { person: { name: string; faces: Array<Record<string, unknown>> } }
);

/**
 * Linked Households (FL-979), the sending side: what a space owner offers to another family's server, and what
 * that server may read. Everything it is told is decided here, at read time, by `visibleAssetIds`.
 *
 * The change feed hooks at the end of this class only decide WHEN an id is looked at again. A row holds ids and
 * says nothing about them, so a missed hook delays a change but cannot expose an item.
 */
@Injectable()
export class HouseholdShareService {
  private directories = new Map<string, { entries: DirectoryEntry[]; at: number }>();

  constructor(
    private shares: HouseholdShareRepository,
    private links: HouseholdLinkRepository,
    private linkService: HouseholdLinkService,
    private peer: HouseholdPeerService,
    private albumUsers: AlbumUserRepository,
    private albums: AlbumRepository,
    private access: AccessRepository,
    private users: UserRepository,
    private storage: StorageRepository,
    private rates: RateLimitRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(HouseholdShareService.name);
  }

  /* ------------------------------------ visibility ------------------------------------ */

  /**
   * THE visibility decision, used by the manifest and by the original route: of these ids, what a viewer member
   * of the space with a locked session may see. `filterVisibleSpaceAssetIds` with the space's own options is the
   * query the space's panels use: in `album_asset` of this space, Timeline or Archive, not trashed, not Locked,
   * no owner's Locked-rule match, not sensitive. A linked album or person adds no item to a space.
   *
   * A live photo's video part is stored `hidden` and outside the album, so it passes only through a still that
   * passes this same query, and only if the part itself is fit to share.
   */
  async visibleAssetIds(albumId: string, ids: string[]): Promise<Set<string>> {
    const unique = [...new Set(ids)];
    const inSpace = (candidates: string[]) =>
      this.albumUsers.filterVisibleSpaceAssetIds(albumId, candidates, SPACE_CONTENT_OPTIONS, { inSpace: true });
    const [direct, motion] = await Promise.all([inSpace(unique), this.shares.getMotionParts(unique)]);
    const stills = await inSpace([...new Set(motion.map(({ stillId }) => stillId))]);
    const visible = new Set(direct);
    for (const { id, stillId } of motion) {
      if (stills.has(stillId)) {
        visible.add(id);
      }
    }
    return visible;
  }

  /* ------------------------------------ owner API ------------------------------------- */

  private async requireOwnedSpace(auth: AuthDto, id: string) {
    await requireAccess(this.access, { auth, permission: Permission.AlbumRead, ids: [id] });
    const album = await this.albums.getById(id, { withAssets: false }, auth.user.id);
    if (!album) {
      throw new NotFoundException('Shared space not found');
    }
    requireSharedSpace(album);
    requireSpaceOwner(album, auth.user.id);
    return album;
  }

  /** The other household's accounts, relayed live and kept in memory for at most five minutes. */
  private async directoryOf(link: Parameters<HouseholdLinkService['readPeer']>[0]) {
    const cached = this.directories.get(link.id);
    if (cached && Date.now() - cached.at < DIRECTORY_CACHE_MS) {
      return cached.entries;
    }
    const entries = Directory.parse(await this.linkService.readPeer(link, 'directory'));
    this.directories.set(link.id, { entries, at: Date.now() });
    return entries;
  }

  async listLinks(auth: AuthDto, id: string): Promise<HouseholdShareLinkDto[]> {
    await this.requireOwnedSpace(auth, id);
    const shares = await this.shares.getSharesOfAlbum(id);
    const members = await this.shares.getMembers(shares.map((share) => share.id));
    const active = (await this.links.getAll()).filter((link) => link.state === 'active');
    return Promise.all(
      active.map(async (link) => {
        const shareIds = new Set(shares.filter((share) => share.linkId === link.id).map((share) => share.id));
        let directory: DirectoryEntry[] | undefined;
        try {
          directory = await this.directoryOf(link);
        } catch {
          this.logger.warn(`The directory of household link ${link.id} could not be read`);
        }
        return {
          linkId: link.id,
          householdName: link.householdName,
          reachable: !!directory,
          directory: directory ?? [],
          members: members
            .filter((member) => shareIds.has(member.shareId))
            .map((member) => ({
              shareId: member.shareId,
              remoteUserId: member.remoteUserId,
              displayName: member.displayName,
              role: member.role,
              state: memberState(member),
            })),
        };
      }),
    );
  }

  async invite(auth: AuthDto, id: string, dto: HouseholdShareInviteDto) {
    await this.requireOwnedSpace(auth, id);
    const link = await this.links.get(dto.linkId);
    if (link?.state !== 'active') {
      throw new BadRequestException('That household link is not active');
    }
    const entry = (await this.directoryOf(link)).find(({ id }) => id === dto.remoteUserId);
    if (!entry) {
      throw new BadRequestException('That account is not in the other household');
    }
    const result = await this.shares.invite({
      albumId: id,
      linkId: link.id,
      remoteUserId: entry.id,
      displayName: peerName(entry.name),
      role: dto.role,
    });
    if (result === 'share-limit') {
      throw new BadRequestException('This household link already has 200 shared spaces');
    }
    if (result === 'member-limit') {
      throw new BadRequestException('This shared space already has 50 members in that household');
    }
    return {
      shareId: result,
      remoteUserId: entry.id,
      displayName: peerName(entry.name),
      role: dto.role,
      state: 'invited',
    };
  }

  async setRole(auth: AuthDto, id: string, shareId: string, remoteUserId: string, role: string) {
    await this.requireOwnedSpace(auth, id);
    if (!(await this.shares.setRole(id, shareId, remoteUserId, role))) {
      throw new NotFoundException('Household member not found');
    }
  }

  async removeMember(auth: AuthDto, id: string, shareId: string, remoteUserId: string) {
    await this.requireOwnedSpace(auth, id);
    if (!(await this.shares.removeMember(id, shareId, remoteUserId))) {
      throw new NotFoundException('Household member not found');
    }
  }

  /* ------------------------------------- peer API ------------------------------------- */

  async directory() {
    const users = await this.shares.getDirectory();
    return users.map(({ id, name, profileImagePath }) => ({
      id,
      name: peerName(name),
      hasAvatar: !!profileImagePath,
    }));
  }

  async avatar(userId: string) {
    const user = UUID.test(userId) ? await this.shares.getDirectoryUser(userId) : undefined;
    if (!user?.profileImagePath) {
      throw new NotFoundException();
    }
    const contentType = mimeTypes.lookup(user.profileImagePath);
    // an SVG is a document, not a picture
    if (!contentType.startsWith('image/') || contentType.includes('svg')) {
      throw new NotFoundException();
    }
    const stats = await this.storage.stat(user.profileImagePath).catch(() => {});
    if (!stats || stats.size > MAX_AVATAR_BYTES) {
      throw new NotFoundException();
    }
    return new FileDownloadResponse({
      path: user.profileImagePath,
      contentType,
      cacheControl: CacheControl.None,
    });
  }

  /**
   * "Something changed". The route answers 204 either way; past the limit a poke is dropped. FL-994: the receiving
   * worker runs elsewhere, so a poke only marks the link for its next tick and carries no data.
   */
  async poke({ link }: HouseholdPeerAccess) {
    const { count } = await this.rates.hit(`household:poke:${link.id}`, 60);
    const admitted = count <= POKES_PER_MINUTE;
    if (admitted) {
      await this.links.update(link.id, { pollRequestedAt: new Date() });
    }
    return admitted;
  }

  async offered({ link }: HouseholdPeerAccess) {
    const shares = await this.shares.getOffered(link.id);
    const members = await this.shares.getMembers(shares.map(({ id }) => id));
    return shares
      .map((share) => ({
        id: share.id,
        name: share.albumName,
        description: share.description ?? '',
        ownerName: peerName(share.ownerName),
        members: members
          .filter((member) => member.shareId === share.id)
          .map((member) => ({
            remoteUserId: member.remoteUserId,
            role: member.role,
            state: memberState(member),
          })),
      }))
      .filter((share) => share.members.length > 0);
  }

  /** Every share route starts here. The answer never says whether the share exists. */
  private async requireShare({ link }: HouseholdPeerAccess, shareId: string) {
    const share = UUID.test(shareId) ? await this.shares.getShare(link.id, shareId) : undefined;
    if (!share) {
      throw refused();
    }
    return share;
  }

  private async requireReadableShare(access: HouseholdPeerAccess, shareId: string) {
    const share = await this.requireShare(access, shareId);
    if (!(await this.shares.hasAcceptedMember(share.id))) {
      throw refused();
    }
    return share;
  }

  async accept(access: HouseholdPeerAccess, shareId: string, userId: string) {
    const share = await this.requireShare(access, shareId);
    if (!UUID.test(userId) || !(await this.shares.accept(share.id, userId))) {
      throw refused();
    }
    return { remoteUserId: userId, state: 'accepted' };
  }

  async leave(access: HouseholdPeerAccess, shareId: string, userId: string) {
    const share = await this.requireShare(access, shareId);
    if (!UUID.test(userId) || !(await this.shares.leave(share.id, userId))) {
      throw refused();
    }
    return { remoteUserId: userId, state: 'left' };
  }

  async manifest(access: HouseholdPeerAccess, shareId: string, query: { cursor?: string; limit?: string }) {
    const share = await this.requireReadableShare(access, shareId);
    const cursor = this.parseCount(query.cursor, 0);
    const limit = Math.min(this.parseCount(query.limit, PAGE_ENTRIES), PAGE_ENTRIES);
    if (limit < 1) {
      throw new BadRequestException('Invalid limit');
    }
    // Rows move and are never pruned, so no cursor is too old. One past the end means this server's database
    // went back in time (a restore): the reader must start again and reconcile.
    if (cursor > (await this.shares.getLastSeq(share.id))) {
      throw new GoneException();
    }

    const rows = await this.shares.getChanges(share.id, cursor, limit + 1);
    const page = rows.slice(0, limit);
    const assets = await this.assetEntries(access, share, page);
    const people = await this.personEntries(share, page);

    const entries: ManifestEntry[] = [];
    let bytes = 0;
    let cut = false;
    for (const { seq, kind, entityId: id } of page) {
      const body = kind === 'asset' ? assets.get(id) : kind === 'person' ? people.get(id) : undefined;
      const entry: ManifestEntry = body ? { seq, kind, id, ...body } : { seq, kind, id, stop: true };
      bytes += Buffer.byteLength(JSON.stringify(entry));
      if (bytes > PAGE_BYTES && entries.length > 0) {
        cut = true;
        break;
      }
      entries.push(entry);
    }
    const last = entries.at(-1)?.seq ?? cursor;
    return {
      version: 1,
      shareId: share.id,
      entries,
      nextCursor: String(last),
      complete: !cut && rows.length <= limit,
    };
  }

  private parseCount(value: string | undefined, fallback: number) {
    if (value === undefined || value === '') {
      return fallback;
    }
    if (!/^\d{1,10}$/.test(value)) {
      throw new BadRequestException('Invalid cursor or limit');
    }
    return Number(value);
  }

  /** Each item resolved now. An id absent from the result is answered `stop`, with no reason. */
  private async assetEntries(
    access: HouseholdPeerAccess,
    share: { id: string; albumId: string },
    page: Array<{ kind: string; entityId: string }>,
  ) {
    const ids = page.filter(({ kind }) => kind === 'asset').map(({ entityId }) => entityId);
    const rows = await this.shares.getAssets(ids);
    const stackIds = [...new Set(rows.flatMap(({ stackId }) => (stackId ? [stackId] : [])))];
    const stacks = await this.shares.getStacks(stackIds);
    const visible = await this.visibleAssetIds(share.albumId, [
      ...ids,
      ...rows.flatMap(({ livePhotoVideoId }) => (livePhotoVideoId ? [livePhotoVideoId] : [])),
      ...stacks.map(({ assetId }) => assetId),
    ]);

    // a stack is named only when its primary and another member are visible here
    const shownStacks = new Map<string, string>();
    for (const stackId of stackIds) {
      const members = stacks.filter((stack) => stack.stackId === stackId);
      const primary = members[0]?.primaryAssetId;
      if (primary && visible.has(primary) && members.filter(({ assetId }) => visible.has(assetId)).length >= 2) {
        shownStacks.set(stackId, primary);
      }
    }

    const exp = Math.floor(Date.now() / 1000) + HOUSEHOLD_DOWNLOAD_SECONDS;
    const signer = this.peer.signer();
    const result = new Map<string, { asset: Record<string, unknown> }>();
    for (const row of rows) {
      if (!visible.has(row.id)) {
        continue;
      }
      const checksum = Buffer.from(row.checksum).toString('hex');
      const primary = row.stackId ? shownStacks.get(row.stackId) : undefined;
      result.set(row.id, {
        asset: {
          id: row.id,
          type: row.type,
          originalFileName: row.originalFileName.slice(0, 255),
          checksum,
          size: row.fileSizeInByte === null ? null : Number(row.fileSizeInByte),
          fileCreatedAt: iso(row.fileCreatedAt),
          localDateTime: iso(row.localDateTime),
          timeZone: row.timeZone,
          description: row.description.slice(0, 10_000),
          rating: row.rating,
          latitude: row.latitude,
          longitude: row.longitude,
          city: row.city?.slice(0, 255) ?? null,
          state: row.state?.slice(0, 255) ?? null,
          country: row.country?.slice(0, 255) ?? null,
          width: row.width,
          height: row.height,
          duration: row.duration,
          livePhotoVideoId: row.livePhotoVideoId && visible.has(row.livePhotoVideoId) ? row.livePhotoVideoId : null,
          stackId: primary ? row.stackId : null,
          stackPrimary: primary === row.id,
          updatedAt: iso(row.updatedAt),
          download: {
            token: signHouseholdDownload(signer, {
              linkId: access.link.id,
              shareId: share.id,
              assetId: row.id,
              checksum,
              exp,
            }),
            expiresAt: new Date(exp * 1000).toISOString(),
          },
        },
      });
    }
    return result;
  }

  /**
   * A linked person, by the space's own name for them, with boxes on visible items only. A person a Locked rule
   * hides, or who is on no visible item, is not listed: their name alone would say who is in the hidden photos.
   */
  private async personEntries(share: { albumId: string }, page: Array<{ kind: string; entityId: string }>) {
    const ids = page.filter(({ kind }) => kind === 'person').map(({ entityId }) => entityId);
    const result = new Map<string, { person: { name: string; faces: Array<Record<string, unknown>> } }>();
    if (ids.length === 0) {
      return result;
    }
    const links = await this.shares.getPersonLinks(share.albumId, ids);
    const album = await this.albums.getById(share.albumId, { withAssets: false });
    const ownerId = album ? spaceOwnerId(album) : undefined;
    const rules = new Map<string, Set<string>>();
    const ruleIds = async (userId: string) => {
      if (!rules.has(userId)) {
        const { personIds } = getPreferences((await this.users.getMetadata(userId)) ?? []).privacy.suppression;
        rules.set(userId, new Set(personIds));
      }
      return rules.get(userId)!;
    };

    for (const link of links) {
      if (
        !ownerId ||
        (await ruleIds(link.personOwnerId)).has(link.personGroupId) ||
        (await ruleIds(ownerId)).has(link.personGroupId)
      ) {
        continue;
      }
      const faces = await this.shares.getPersonFaces(share.albumId, link.personGroupId);
      const visible = await this.visibleAssetIds(
        share.albumId,
        faces.map(({ assetId }) => assetId),
      );
      const shown = faces
        .filter(({ assetId }) => visible.has(assetId))
        .map((face) => ({
          assetId: face.assetId,
          x1: face.boundingBoxX1,
          y1: face.boundingBoxY1,
          x2: face.boundingBoxX2,
          y2: face.boundingBoxY2,
          width: face.imageWidth,
          height: face.imageHeight,
        }));
      if (shown.length > 0) {
        result.set(link.id, { person: { name: peerName(link.name), faces: shown } });
      }
    }
    return result;
  }

  /**
   * One original. The token and the visibility check both run before a byte is sent: a token outlives a lock by
   * up to fifteen minutes, so it is never enough alone.
   */
  async original(access: HouseholdPeerAccess, shareId: string, assetId: string, token: unknown) {
    const share = await this.requireReadableShare(access, shareId);
    if (!UUID.test(assetId) || typeof token !== 'string') {
      throw refused();
    }
    const asset = await this.shares.getOriginal(assetId);
    if (
      !asset ||
      !isHouseholdDownloadValid(token, this.peer.signer().publicJwk.x, {
        linkId: access.link.id,
        shareId: share.id,
        assetId,
        checksum: Buffer.from(asset.checksum).toString('hex'),
      }) ||
      !(await this.visibleAssetIds(share.albumId, [assetId])).has(assetId)
    ) {
      throw refused();
    }
    const release = await this.streamSlot(access.link.id);
    return new FileDownloadResponse({
      path: asset.originalPath,
      contentType: mimeTypes.lookup(asset.originalPath),
      cacheControl: CacheControl.None,
      attachment: true,
      release,
    });
  }

  // ponytail: a lease lasts fifteen minutes, as Buddy's does, so a longer download stops counting after that
  private async streamSlot(linkId: string) {
    const token = randomUUID();
    for (let slot = 0; slot < STREAMS_PER_LINK; slot++) {
      const key = `household:download:${linkId}:${slot}`;
      if (await this.rates.claimUploadStream(key, token)) {
        return () => this.rates.releaseUploadStream(key, token);
      }
    }
    throw new ServiceUnavailableException('Household download concurrency reached');
  }

  /* --------------------------------- change feed hooks --------------------------------- */

  /**
   * Visibility is decided when a page is read, so a missed hook delays a change but cannot expose an item. A hook
   * never fails the action that fired it.
   */
  private async feed(action: () => Promise<unknown>) {
    try {
      if (await this.shares.hasShares()) {
        await action();
      }
    } catch (error) {
      this.logger.warn(`Household share feed was not updated: ${error}`);
    }
  }

  // one method per event: `@OnEvent` keeps a single name per method
  @OnEvent({ name: 'AssetsChanged' })
  onAssetsChanged({ assetIds }: ArgOf<'AssetsChanged'>) {
    return this.feed(() => this.shares.touchAssets(assetIds));
  }

  @OnEvent({ name: 'AssetTrashAll' })
  onAssetsTrashed({ assetIds }: ArgOf<'AssetTrashAll'>) {
    return this.feed(() => this.shares.touchAssets(assetIds));
  }

  @OnEvent({ name: 'AssetDeleteAll' })
  onAssetsDeleted({ assetIds }: ArgOf<'AssetDeleteAll'>) {
    return this.feed(() => this.shares.touchAssets(assetIds));
  }

  @OnEvent({ name: 'AssetRestoreAll' })
  onAssetsRestored({ assetIds }: ArgOf<'AssetRestoreAll'>) {
    return this.feed(() => this.shares.touchAssets(assetIds));
  }

  @OnEvent({ name: 'AssetLockAll' })
  onAssetsLockAll({ assetIds }: ArgOf<'AssetLockAll'>) {
    return this.feed(() => this.shares.touchAssets(assetIds));
  }

  @OnEvent({ name: 'AssetLocked' })
  onAssetsLocked({ assetIds }: ArgOf<'AssetLocked'>) {
    return this.feed(() => this.shares.touchAssets(assetIds));
  }

  @OnEvent({ name: 'HouseholdFeedAssets' })
  onFeedAssets({ assetIds }: ArgOf<'HouseholdFeedAssets'>) {
    return this.feed(() => this.shares.touchAssets(assetIds));
  }

  @OnEvent({ name: 'AssetChanged' })
  onAssetChanged({ assetId }: ArgOf<'AssetChanged'>) {
    return this.feed(() => this.shares.touchAssets([assetId]));
  }

  @OnEvent({ name: 'AssetMetadataExtracted' })
  onAssetMetadata({ assetId }: ArgOf<'AssetMetadataExtracted'>) {
    return this.feed(() => this.shares.touchAssets([assetId]));
  }

  @OnEvent({ name: 'AssetTrash' })
  onAssetTrash({ assetId }: ArgOf<'AssetTrash'>) {
    return this.feed(() => this.shares.touchAssets([assetId]));
  }

  @OnEvent({ name: 'AssetDelete' })
  onAssetDelete({ assetId }: ArgOf<'AssetDelete'>) {
    return this.feed(() => this.shares.touchAssets([assetId]));
  }

  @OnEvent({ name: 'AssetTag' })
  onAssetTag({ assetId }: ArgOf<'AssetTag'>) {
    return this.feed(() => this.shares.touchAssets([assetId]));
  }

  @OnEvent({ name: 'AssetUntag' })
  onAssetUntag({ assetId }: ArgOf<'AssetUntag'>) {
    return this.feed(() => this.shares.touchAssets([assetId]));
  }

  @OnEvent({ name: 'AssetHide' })
  onAssetHide({ assetId }: ArgOf<'AssetHide'>) {
    return this.feed(() => this.shares.touchAssets([assetId]));
  }

  @OnEvent({ name: 'AssetShow' })
  onAssetShow({ assetId }: ArgOf<'AssetShow'>) {
    return this.feed(() => this.shares.touchAssets([assetId]));
  }

  @OnEvent({ name: 'AlbumUpdate' })
  onAlbumUpdate({ id }: ArgOf<'AlbumUpdate'>) {
    return this.feed(() => this.shares.seedAlbum(id));
  }

  @OnEvent({ name: 'HouseholdFeedPerson' })
  onPerson({ albumId, personLinkId }: ArgOf<'HouseholdFeedPerson'>) {
    return this.feed(() => this.shares.touchPerson(albumId, personLinkId));
  }

  @OnEvent({ name: 'LockedRulesChanged' })
  onLockedRules({ userId }: ArgOf<'LockedRulesChanged'>) {
    return this.feed(() => this.shares.touchOwner(userId));
  }
}
