import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable } from '@nestjs/common';
import z from 'zod';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { StoredPinnedCollection } from 'src/dtos/pinned-collection.dto.js';
import { PinnedCollectionsResponseDto, PinnedCollectionsUpdateDto } from 'src/dtos/pinned-collection.dto.js';
import { MetadataSearchDto, SmartSearchDto } from 'src/dtos/search.dto.js';
import { AssetType, AssetVisibility } from 'src/enum.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { AlbumService } from 'src/services/album.service.js';
import { MemoryService } from 'src/services/memory.service.js';
import { PersonService } from 'src/services/person.service.js';
import { PetService } from 'src/services/pet.service.js';
import { SearchService } from 'src/services/search.service.js';
import { UserService } from 'src/services/user.service.js';

type PinSummary = Pick<
  PinnedCollectionsResponseDto['pins'][number],
  'title' | 'count' | 'coverAssetId' | 'countCapped'
>;

/** FL-232: user metadata stores references only. Hydrated names/counts/covers are never persisted. */
@Injectable()
export class PinnedCollectionService {
  constructor(
    private users: UserRepository,
    private albums: AlbumService,
    private people: PersonService,
    private pets: PetService,
    private memories: MemoryService,
    private search: SearchService,
    private preferences: UserService,
  ) {}

  async get(auth: AuthDto): Promise<PinnedCollectionsResponseDto> {
    this.requireSession(auth);
    const stored = await this.users.getPinnedCollections(auth.user.id);
    return this.hydrate(auth, stored?.value.pins ?? [], stored?.updateId ?? null);
  }

  async set(auth: AuthDto, input: PinnedCollectionsUpdateDto): Promise<PinnedCollectionsResponseDto> {
    this.requireSession(auth);
    const dto = PinnedCollectionsUpdateDto.schema.parse(input);
    const stored = await this.users.getPinnedCollections(auth.user.id);
    if ((stored?.updateId ?? null) !== dto.expectedRevision) {
      throw new ConflictException('The pin list changed since it was loaded');
    }
    const pins: StoredPinnedCollection[] = [];
    for (const pin of dto.pins) {
      const previous = stored?.value.pins.find(({ id }) => id === pin.id);
      const targetId = pin.targetId ?? (previous?.kind === pin.kind ? previous.targetId : undefined);
      if (!targetId) {
        throw new BadRequestException('An unavailable pin must already belong to this account');
      }
      const resolved = { ...pin, targetId };
      if (
        (!previous || previous.kind !== pin.kind || previous.targetId !== targetId) &&
        !(await this.summary(auth, resolved))
      ) {
        throw new BadRequestException('Not found or no access to the pin target');
      }
      pins.push(resolved);
    }
    if (
      new Set(pins.map(({ kind, targetId }) => `${kind === 'smart-album' ? 'album' : kind}:${targetId}`)).size !==
      pins.length
    ) {
      throw new BadRequestException('Each collection may be pinned only once');
    }
    const updated = await this.users.setPinnedCollections(auth.user.id, pins, dto.expectedRevision);
    if (!updated) {
      throw new ConflictException('The pin list changed since it was loaded');
    }
    return this.hydrate(auth, pins, updated.updateId);
  }

  private requireSession(auth: AuthDto) {
    if (!auth.session || auth.sharedLink) {
      throw new ForbiddenException('Pinned collections require a user session');
    }
  }

  private async hydrate(
    auth: AuthDto,
    refs: StoredPinnedCollection[],
    revision: string | null,
  ): Promise<PinnedCollectionsResponseDto> {
    const pins: PinnedCollectionsResponseDto['pins'] = [];
    // ponytail: at most 50 pins, hydrated sequentially; batch domain reads if this becomes slow.
    for (const ref of refs) {
      const summary = await this.summary(auth, ref);
      pins.push(
        summary
          ? { ...ref, unavailable: false, ...summary }
          : {
              id: ref.id,
              kind: ref.kind,
              targetId: null,
              unavailable: true,
              title: null,
              count: null,
              countCapped: false,
              coverAssetId: null,
            },
      );
    }
    return { revision, pins };
  }

  private async summary(auth: AuthDto, pin: StoredPinnedCollection): Promise<PinSummary | undefined> {
    try {
      switch (pin.kind) {
        case 'album':
        case 'smart-album': {
          const album = await this.albums.get(auth, pin.targetId);
          if (pin.kind === 'smart-album' && !album.isSmart) {
            return;
          }
          return {
            title: album.albumName,
            count: album.assetCount,
            coverAssetId: album.albumThumbnailAssetId,
            countCapped: false,
          };
        }
        case 'person': {
          const person = await this.people.getById(auth, pin.targetId);
          return await this.searchSummary(auth, person.name, { personIds: [pin.targetId] });
        }
        case 'pet': {
          const pet = await this.pets.get(auth, pin.targetId);
          // Pet identity reads do not apply the full media privacy filter to their counts/covers.
          return await this.searchSummary(auth, pet.name, { petIds: [pin.targetId] });
        }
        case 'memory': {
          const memory = await this.memories.get(auth, pin.targetId);
          return {
            title: memory.title ?? 'Memory',
            count: memory.assets.length,
            coverAssetId: memory.assets[0]?.id ?? null,
            countCapped: false,
          };
        }
        case 'saved-search': {
          const preferences = await this.preferences.getMyPreferences(auth);
          const saved = preferences.savedSearches?.find(({ name }) => name === pin.targetId);
          if (saved) {
            return await this.searchSummary(auth, saved.name, saved.query);
          }
          return;
        }
        case 'builtin': {
          const builtins: Record<string, { title: string; query: Record<string, unknown> }> = {
            favourites: { title: 'Favourites', query: { isFavorite: true } },
            photos: { title: 'Photos', query: { type: AssetType.Image } },
            videos: { title: 'Videos', query: { type: AssetType.Video } },
            'live-photos': { title: 'Live Photos', query: { isMotion: true } },
            archive: { title: 'Archive', query: { visibility: AssetVisibility.Archive } },
            locked: { title: 'Locked', query: { visibility: AssetVisibility.Locked } },
            'recently-deleted': { title: 'Recently Deleted', query: { filter: { trashedAt: { ne: null } } } },
          };
          const builtin = builtins[pin.targetId];
          if (builtin) {
            return await this.searchSummary(auth, builtin.title, builtin.query);
          }
        }
      }
    } catch (error) {
      // Lost access, suppression, deleted targets and obsolete saved queries all lose hydration.
      // Operational failures still propagate; they must not masquerade as unavailable targets.
      if (
        error instanceof z.ZodError ||
        (error instanceof HttpException && [400, 401, 403, 404].includes(error.getStatus()))
      ) {
        return;
      }
      throw error;
    }
  }

  private async searchSummary(auth: AuthDto, title: string, query: Record<string, unknown>): Promise<PinSummary> {
    const { page: _page, cursor: _cursor, size: _size, ...body } = query;
    const smart = body.query !== undefined || body.queryAssetId !== undefined;
    if (!smart) {
      const results = await this.search.searchMetadata(
        auth,
        MetadataSearchDto.schema.parse({ ...body, size: 1 }),
        true,
      );
      return {
        title,
        count: results.assets.total,
        countCapped: false,
        coverAssetId: results.assets.items[0]?.id ?? null,
      };
    }
    const stats = await this.search.searchSmartStatistics(auth, SmartSearchDto.schema.parse(body));
    const results = await this.search.searchSmart(auth, SmartSearchDto.schema.parse({ ...body, size: 1 }));
    return {
      title,
      count: stats.total,
      countCapped: 'capped' in stats && stats.capped,
      coverAssetId: results.assets.items[0]?.id ?? null,
    };
  }
}
