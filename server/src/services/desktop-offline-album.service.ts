import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { OnEvent } from 'src/decorators.js';
import { AlbumKind, AlbumUserRole, AssetType, AssetVisibility, CacheControl } from 'src/enum.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { BookmarkRepository } from 'src/repositories/bookmark.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { AuthService } from 'src/services/auth.service.js';
import { hexOrBufferToBase64 } from 'src/utils/bytes.js';
import { stableServerId } from 'src/utils/frameleaf-server-identity.js';
import { isLockedPath, isPlainCopyPath } from 'src/utils/locked-read.js';
import { mimeTypes } from 'src/utils/mime-types.js';

const MINUTE = 60 * 1000;
const HANDOFF_LIFETIME = 5 * MINUTE;
const IDLE_GRANT_LIFETIME = 48 * 60 * MINUTE;
const MAX_GRANTS = 256;
const MAX_ORIGINALS = 1000;
const MAX_SCAN = 1100;
const notAvailable = () => new NotFoundException('Offline album unavailable');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const tokenKey = (token?: string) =>
  typeof token === 'string' && /^[\w-]{43}$/.test(token) ? digest(token) : undefined;

const supportedMime = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/heic',
  'image/heif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
]);
const cleanName = (value: string, filename = false) =>
  [...value]
    .filter((character) => !/\p{Cc}/u.test(character) && (!filename || !['/', '\\'].includes(character)))
    .slice(0, 256)
    .join('');

type Original = { id: string; name: string; mime: string; checksum: string };
type Plan = { id: string; name: string; items: Original[] };
type Grant = {
  host: string;
  serverId: string;
  ownerId: string;
  sessionId: string;
  plan: Plan;
  expires: number;
};

@Injectable()
export class DesktopOfflineAlbumService {
  private readonly handoffs = new Map<string, Grant>();
  private readonly grants = new Map<string, Grant>();
  private readonly streams = new Map<string, Set<() => void>>();

  constructor(
    private authService: AuthService,
    private albums: AlbumRepository,
    private members: BookmarkRepository,
    private media: AssetMediaService,
    private systemMetadataRepository: SystemMetadataRepository,
  ) {}

  async issue(auth: AuthDto, id: string, host: string) {
    if (!auth.session || auth.apiKey || auth.oauthApp || auth.sharedLink) throw notAvailable();
    const sessionId = auth.session.id;
    const ownerId = auth.user.id;
    const [serverId, owner] = await Promise.all([
      stableServerId({ systemMetadataRepository: this.systemMetadataRepository }),
      this.authService.authorizeOfflineAlbumSession(sessionId, ownerId),
    ]);
    if (!owner) throw notAvailable();
    const plan = await this.buildPlan(owner, id);
    if (plan.items.length === 0) throw notAvailable();
    if (!(await this.authService.authorizeOfflineAlbumSession(sessionId, ownerId))) throw notAvailable();
    return { token: this.store(this.handoffs, { host, serverId, ownerId, sessionId, plan }, HANDOFF_LIFETIME) };
  }

  async redeem(id: string, host: string, token?: string) {
    const grant = this.find(this.handoffs, id, host, token);
    this.handoffs.delete(tokenKey(token)!);
    const plan = await this.revalidate(grant);
    // A new grant replaces earlier ones for the same session and album, so the cap counts albums, not clicks.
    for (const [key, value] of this.grants) {
      if (value.sessionId === grant.sessionId && value.plan.id === grant.plan.id) this.grants.delete(key);
    }
    return {
      grant: this.store(this.grants, grant, IDLE_GRANT_LIFETIME),
      serverId: grant.serverId,
      scopeId: digest(JSON.stringify([grant.serverId, grant.ownerId, grant.sessionId])),
      plan,
    };
  }

  async plan(id: string, host: string, token?: string) {
    const grant = this.find(this.grants, id, host, token);
    const plan = await this.revalidate(grant);
    grant.expires = Date.now() + IDLE_GRANT_LIFETIME;
    return plan;
  }

  async original(id: string, assetId: string, host: string, token: string | undefined, abort: () => void) {
    const grant = this.find(this.grants, id, host, token);
    const allowed = grant.plan.items.find((item) => item.id === assetId);
    if (!allowed) throw notAvailable();
    const controller = new AbortController();
    const interrupt = () => {
      controller.abort();
      abort();
    };
    const active = this.streams.get(grant.sessionId) ?? new Set<() => void>();
    this.streams.set(grant.sessionId, active);
    active.add(interrupt);
    const close = () => {
      active.delete(interrupt);
      if (active.size === 0 && this.streams.get(grant.sessionId) === active) this.streams.delete(grant.sessionId);
    };

    let file: Awaited<ReturnType<AssetMediaService['downloadOriginal']>> | undefined;
    try {
      const auth = await this.authorize(grant);
      await this.checkOriginal(auth, id, allowed);
      file = await this.media.downloadOriginal(auth, assetId, { edited: false }, controller.signal);
      if ((await isLockedPath(file.path)) || isPlainCopyPath(file.path)) throw notAvailable();
      const current = await this.authorize(grant);
      await this.checkOriginal(current, id, allowed);
      controller.signal.throwIfAborted();
      grant.expires = Date.now() + IDLE_GRANT_LIFETIME;
      // The public grant request has no authenticated viewer for a file sealed after the check.
      return { file: { ...file, viewerId: undefined, cacheControl: CacheControl.PrivateWithoutCache }, close };
    } catch (error) {
      close();
      await file?.release?.();
      throw error;
    }
  }

  @OnEvent({ name: 'SessionDelete' })
  onSessionDelete({ sessionId }: ArgOf<'SessionDelete'>) {
    for (const map of [this.handoffs, this.grants]) {
      for (const [key, grant] of map) {
        if (grant.sessionId === sessionId) map.delete(key);
      }
    }
    const streams = this.streams.get(sessionId);
    this.streams.delete(sessionId);
    for (const abort of streams ?? []) abort();
  }

  private store(map: Map<string, Grant>, grant: Omit<Grant, 'expires'>, ttl: number) {
    const now = Date.now();
    for (const [key, value] of map) if (value.expires <= now) map.delete(key);
    if (map.size >= MAX_GRANTS) throw new ConflictException('Too many offline album requests');
    const token = randomBytes(32).toString('base64url');
    map.set(digest(token), { ...grant, expires: now + ttl });
    return token;
  }

  private find(map: Map<string, Grant>, id: string, host: string, token?: string) {
    const key = tokenKey(token);
    const grant = key && map.get(key);
    if (!grant || grant.plan.id !== id || grant.host !== host || grant.expires <= Date.now()) throw notAvailable();
    return grant;
  }

  private async authorize(grant: Grant) {
    const [auth, serverId] = await Promise.all([
      this.authService.authorizeOfflineAlbumSession(grant.sessionId, grant.ownerId),
      stableServerId({ systemMetadataRepository: this.systemMetadataRepository }),
    ]);
    if (!auth || serverId !== grant.serverId) throw notAvailable();
    return auth;
  }

  private async revalidate(grant: Grant) {
    const auth = await this.authorize(grant);
    const plan = await this.buildPlan(auth, grant.plan.id);
    if (JSON.stringify(plan) !== JSON.stringify(grant.plan)) throw notAvailable();
    await this.authorize(grant);
    return plan;
  }

  private async ownedAlbum(auth: AuthDto, id: string) {
    const album = await this.albums.getById(id, { withAssets: false }, auth.user.id);
    if (
      !album ||
      album.kind !== AlbumKind.Album ||
      album.isLocked ||
      !album.albumUsers?.some((member) => member.role === AlbumUserRole.Owner && member.user.id === auth.user.id)
    ) {
      throw notAvailable();
    }
    return album;
  }

  private async buildPlan(auth: AuthDto, id: string): Promise<Plan> {
    const album = await this.ownedAlbum(auth, id);
    const candidates = await this.members.getAlbumAssets(auth, id, undefined, MAX_SCAN + 1);
    if (candidates.length > MAX_SCAN) throw notAvailable();
    const items = candidates.flatMap((asset) => {
      const item = this.originalOf(auth, asset);
      return item ? [item] : [];
    });
    if (items.length > MAX_ORIGINALS || new Set(items.map((item) => item.id)).size !== items.length)
      throw notAvailable();
    await this.ownedAlbum(auth, id);
    return { id, name: cleanName(album.albumName), items };
  }

  private originalOf(
    auth: AuthDto,
    asset: Awaited<ReturnType<BookmarkRepository['getAlbumAssets']>>[number],
  ): Original | undefined {
    if (
      asset.ownerId !== auth.user.id ||
      asset.isLocked ||
      asset.deletedAt ||
      (asset.visibility !== AssetVisibility.Timeline && asset.visibility !== AssetVisibility.Archive) ||
      (asset.type !== AssetType.Image && asset.type !== AssetType.Video)
    )
      return;
    const checksum = hexOrBufferToBase64(asset.checksum);
    if (!checksum || ![20, 32].includes(Buffer.from(checksum, 'base64').length)) throw notAvailable();
    const mime = mimeTypes.lookup(asset.originalFileName);
    return {
      id: asset.id,
      name: cleanName(asset.originalFileName, true),
      mime: mime && supportedMime.has(mime) ? mime : 'application/octet-stream',
      checksum,
    };
  }

  private async checkOriginal(auth: AuthDto, id: string, allowed: Original) {
    await this.ownedAlbum(auth, id);
    const [asset] = await this.members.getAlbumAssets(auth, id, undefined, 1, allowed.id);
    if (!asset || JSON.stringify(this.originalOf(auth, asset)) !== JSON.stringify(allowed)) throw notAvailable();
  }
}
