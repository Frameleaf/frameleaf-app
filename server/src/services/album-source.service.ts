import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  AlbumSourceInput,
  type AlbumSourceLink,
  AlbumSourceLinkResponseDto,
  AlbumSourceOutcome,
  AlbumSourceResolveDto,
  AlbumSourceResolveResponseDto,
  AlbumSourceUpdateDto,
  AlbumSourceUpdateResponseDto,
  mapAlbumSourceLink,
} from 'src/dtos/album-source.dto.js';
import { BulkIdErrorReason, BulkIdResponseDto, BulkIdsDto } from 'src/dtos/asset-ids.response.dto.js';
import { AlbumService } from 'src/services/album.service.js';
import { BaseService } from 'src/services/base.service.js';

const sourceLock = (userId: string, source: { kind: string; sourceId: string; deviceKey: string | null }) =>
  `album-source:${userId}:${source.kind}:${source.deviceKey ?? ''}:${source.sourceId}`;
const nameLock = (userId: string, name: string) => `album-source-name:${userId}:${name.trim().toLowerCase()}`;
const albumLock = (albumId: string) => `album-source-album:${albumId}`;

/**
 * FL-331 (NAPI-015): maps phone albums (iOS Photos) and folders (Android) to their owner's server albums so the
 * native apps sync phone albums without ever creating two albums for one source, merging by name with albums
 * already on the server.
 *
 * Owner rule (2026-10-03): deleting media never syncs. Nothing here deletes, trashes or hides an asset: removing
 * assets only takes out album memberships a link's sync added, and unlinking keeps the album and its photos.
 */
@Injectable()
export class AlbumSourceService extends BaseService {
  private get albums() {
    return BaseService.create(AlbumService, this);
  }

  async getAll(auth: AuthDto): Promise<AlbumSourceLinkResponseDto[]> {
    const links = await this.albumSourceRepository.getAll(null, auth.user.id);
    return links.map((link) => mapAlbumSourceLink(link));
  }

  /**
   * For each source: its existing link, else a link to the owner's oldest album with the same trimmed,
   * case-insensitive name, else a new album. Each source is resolved holding locks on the source and on its
   * name, so concurrent devices end up with one album per source and one album per new name.
   */
  async resolve(auth: AuthDto, dto: AlbumSourceResolveDto): Promise<AlbumSourceResolveResponseDto> {
    const links: AlbumSourceResolveResponseDto['links'] = [];
    for (const input of dto.sources) {
      links.push(await this.resolveOne(auth, input));
    }
    return { links };
  }

  private async resolveOne(auth: AuthDto, input: AlbumSourceInput) {
    const userId = auth.user.id;
    const source = { kind: input.kind, sourceId: input.sourceId, deviceKey: input.deviceKey ?? null };
    const name = input.name.trim();
    return this.albumSourceRepository.withLocks([sourceLock(userId, source), nameLock(userId, name)], async (tx) => {
      const existing = await this.albumSourceRepository.getBySource(tx, userId, source);
      if (existing?.albumName !== null && existing) {
        return { ...mapAlbumSourceLink(existing as AlbumSourceLink), outcome: AlbumSourceOutcome.Existing };
      }
      if (existing) {
        // its album was deleted (or is no longer the owner's): resolve the source again
        await this.albumSourceRepository.delete(tx, existing.id);
      }

      let outcome = AlbumSourceOutcome.Merged;
      let albumId = (await this.albumSourceRepository.findOwnedAlbumByName(tx, userId, name))?.id;
      if (!albumId) {
        outcome = AlbumSourceOutcome.Created;
        albumId = (await this.albums.create(auth, { albumName: name })).id;
      }
      const id = await this.albumSourceRepository.create(tx, { userId, albumId, ...source, name });
      const link = await this.albumSourceRepository.get(tx, userId, id);
      return { ...mapAlbumSourceLink(link as AlbumSourceLink), outcome };
    });
  }

  /**
   * Adds assets to the linked album and records the memberships this link's sync added. Idempotent: an asset
   * this link (or another link to the same album) already added counts as added; one put in the album by hand
   * is reported as a duplicate and never recorded, so the sync can never take it out.
   */
  async addAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    const link = await this.findLink(auth, id);
    return this.albumSourceRepository.withLocks([albumLock(link.albumId)], async (tx) => {
      const ids = [...new Set(dto.ids)];
      const recorded = await this.albumSourceRepository.getRecordedAssetIds(tx, link.albumId, ids);
      const results = await this.albums.addAssets(auth, link.albumId, { ids });
      const added = results.filter(({ success }) => success).map(({ id }) => id);
      const syncOwned = results
        .filter(({ success, error, id }) => !success && error === BulkIdErrorReason.DUPLICATE && recorded.has(id))
        .map(({ id }) => id);
      await this.albumSourceRepository.record(tx, link.id, [...added, ...syncOwned]);
      const owned = new Set(syncOwned);
      return results.map((result) => (owned.has(result.id) ? { id: result.id, success: true } : result));
    });
  }

  /**
   * Takes out only the memberships this link recorded. A membership another link also recorded stays in the
   * album (only this link's record goes). Never deletes, trashes or hides the asset itself.
   */
  async removeAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    const link = await this.findLink(auth, id);
    return this.albumSourceRepository.withLocks([albumLock(link.albumId)], async (tx) => {
      const ids = [...new Set(dto.ids)];
      const mine = await this.albumSourceRepository.getRecordedAssetIds(tx, link.albumId, ids, link.id);
      await this.albumSourceRepository.unrecord(tx, link.id, [...mine]);
      const stillRecorded = await this.albumSourceRepository.getRecordedAssetIds(tx, link.albumId, [...mine]);
      const remove = [...mine.difference(stillRecorded)];
      if (remove.length > 0) {
        await this.albums.removeAssets(auth, link.albumId, { ids: remove });
      }
      return ids.map((assetId) =>
        mine.has(assetId)
          ? { id: assetId, success: true }
          : { id: assetId, success: false, error: BulkIdErrorReason.NOT_FOUND },
      );
    });
  }

  /**
   * The phone renamed the source: the server album follows only while its name still equals the name it last
   * followed (nobody renamed it on the server). `sourceId` re-keys the link (an Android folder rename changes its
   * bucket); another link already holding it is a conflict.
   */
  async update(auth: AuthDto, id: string, dto: AlbumSourceUpdateDto): Promise<AlbumSourceUpdateResponseDto> {
    const link = await this.findLink(auth, id);
    const name = dto.name.trim();
    const sourceId = dto.sourceId && dto.sourceId !== link.sourceId ? dto.sourceId : undefined;
    const target = { kind: link.sourceKind, sourceId: sourceId ?? link.sourceId, deviceKey: link.deviceKey };
    const keys = [
      sourceLock(auth.user.id, { kind: link.sourceKind, sourceId: link.sourceId, deviceKey: link.deviceKey }),
      albumLock(link.albumId),
      ...(sourceId ? [sourceLock(auth.user.id, target)] : []),
    ];
    return this.albumSourceRepository.withLocks(keys, async (tx) => {
      const current = await this.albumSourceRepository.get(tx, auth.user.id, id);
      if (!current || current.albumName === null) {
        throw new NotFoundException('Album source link not found');
      }
      if (sourceId) {
        const holder = await this.albumSourceRepository.getBySource(tx, auth.user.id, target);
        if (holder && holder.id !== id) {
          throw new ConflictException('Another link already holds this source');
        }
      }
      const renamed = current.albumName === current.lastSourceName && current.albumName !== name;
      if (renamed) {
        await this.albums.update(auth, current.albumId, { albumName: name });
      }
      await this.albumSourceRepository.update(tx, id, { lastSourceName: name, sourceId });
      const updated = (await this.albumSourceRepository.get(tx, auth.user.id, id)) as AlbumSourceLink;
      return { ...mapAlbumSourceLink(updated), renamed };
    });
  }

  /** Unlinks the source and forgets what its sync added. The album and its photos are kept. */
  async delete(auth: AuthDto, id: string): Promise<void> {
    const link = await this.albumSourceRepository.get(null, auth.user.id, id);
    if (!link) {
      throw new NotFoundException('Album source link not found');
    }
    await this.albumSourceRepository.write((tx) => this.albumSourceRepository.delete(tx, id));
  }

  private async findLink(auth: AuthDto, id: string): Promise<AlbumSourceLink> {
    const link = await this.albumSourceRepository.get(null, auth.user.id, id);
    if (!link || link.albumName === null) {
      throw new NotFoundException('Album source link not found');
    }
    return link as AlbumSourceLink;
  }
}
