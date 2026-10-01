import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  PhotographyPhotosDto,
  PhotographyPhotoQueryDto,
  PhotographyRatingDto,
  PhotographyWorkspaceDto,
  PhotographyWorkspaceSaveDto,
  type StoredShoot,
} from 'src/dtos/photography-workspace.dto.js';
import { MetadataSearchDto } from 'src/dtos/search.dto.js';
import { AlbumKind, AssetType, AssetVisibility } from 'src/enum.js';
import { PhotographyWorkspaceRepository } from 'src/repositories/photography-workspace.repository.js';
import { AlbumService } from 'src/services/album.service.js';
import { AssetService } from 'src/services/asset.service.js';
import { SearchService } from 'src/services/search.service.js';

@Injectable()
export class PhotographyWorkspaceService {
  constructor(
    private repository: PhotographyWorkspaceRepository,
    private albums: AlbumService,
    private search: SearchService,
    private assets: AssetService,
  ) {}

  private session(auth: AuthDto): AuthDto {
    if (!auth.session || auth.sharedLink || auth.apiKey) {
      throw new ForbiddenException('Photography requires a user session');
    }
    // Photography never surfaces Locked content, even while the owner's PIN session is elevated.
    return { ...auth, session: { ...auth.session, hasElevatedPermission: false } };
  }

  private async ownedAlbum(auth: AuthDto, albumId: string) {
    const album = await this.albums.get(auth, albumId);
    if (album.albumUsers[0]?.user.id !== auth.user.id || album.kind !== AlbumKind.Album || album.isSmart) {
      throw new ForbiddenException('Source album is unavailable');
    }
    return album;
  }

  async get(auth: AuthDto): Promise<PhotographyWorkspaceDto> {
    const safeAuth = this.session(auth);
    const stored = await this.repository.get(auth.user.id);
    return this.hydrate(safeAuth, stored?.value.shoots ?? [], stored?.updateId ?? null);
  }

  private async hydrate(
    auth: AuthDto,
    shoots: StoredShoot[],
    revision: string | null,
  ): Promise<PhotographyWorkspaceDto> {
    const result: PhotographyWorkspaceDto['shoots'] = [];
    // ponytail: at most 200 shoots; batch authorized summaries if directory latency requires it.
    for (const shoot of shoots) {
      try {
        const album = await this.ownedAlbum(auth, shoot.albumId);
        result.push({
          ...shoot,
          unavailable: false,
          coverAssetId: album.albumThumbnailAssetId,
          assetCount: album.assetCount,
        });
      } catch (error) {
        if (!(error instanceof HttpException) || ![400, 403, 404].includes(error.getStatus())) {
          throw error;
        }
        result.push({ ...shoot, albumId: null, unavailable: true, coverAssetId: null, assetCount: null });
      }
    }
    return { revision, shoots: result };
  }

  async save(auth: AuthDto, input: PhotographyWorkspaceSaveDto): Promise<PhotographyWorkspaceDto> {
    const safeAuth = this.session(auth);
    const dto = PhotographyWorkspaceSaveDto.schema.parse(input);
    const stored = await this.repository.get(auth.user.id);
    if ((stored?.updateId ?? null) !== dto.expectedRevision) {
      throw new ConflictException('Shoots changed; reload before saving');
    }
    const shoots: StoredShoot[] = [];
    const validateAlbumIds: string[] = [];
    for (const shoot of dto.shoots) {
      if (shoot.albumId === null) {
        const previous = stored?.value.shoots.find(({ id }) => id === shoot.id);
        if (!previous) {
          throw new BadRequestException('Unavailable shoots must already belong to you');
        }
        shoots.push(previous);
        continue;
      }
      await this.ownedAlbum(safeAuth, shoot.albumId);
      shoots.push({ ...shoot, albumId: shoot.albumId });
      validateAlbumIds.push(shoot.albumId);
    }
    if (new Set(shoots.map(({ albumId }) => albumId)).size !== shoots.length) {
      throw new BadRequestException('An album can belong to only one shoot');
    }
    const saved = await this.repository.save(auth.user.id, shoots, dto.expectedRevision, validateAlbumIds);
    if (!saved) {
      throw new ConflictException('Shoots changed; reload before saving');
    }
    return this.hydrate(safeAuth, shoots, saved.updateId);
  }

  private async shoot(auth: AuthDto, id: string) {
    const stored = await this.repository.get(auth.user.id);
    const shoot = stored?.value.shoots.find((shoot) => shoot.id === id);
    if (!shoot) {
      throw new NotFoundException('Shoot not found');
    }
    await this.ownedAlbum(auth, shoot.albumId);
    return shoot;
  }

  async photos(auth: AuthDto, id: string, query: PhotographyPhotoQueryDto): Promise<PhotographyPhotosDto> {
    const safeAuth = this.session(auth);
    const shoot = await this.shoot(safeAuth, id);
    const result = await this.search.searchMetadata(
      safeAuth,
      MetadataSearchDto.schema.parse({
        filter: {
          albumIds: { any: [shoot.albumId] },
          type: { eq: AssetType.Image },
          visibility: { ne: AssetVisibility.Locked },
        },
        cursor: query.cursor,
        size: 80,
        withExif: true,
        withStacked: true,
      }),
    );
    const current = await this.repository.currentRevisions(
      auth.user.id,
      result.assets.items.map(({ id }) => id),
    );
    return {
      nextCursor: result.assets.nextCursor ?? null,
      photos: result.assets.items.map((asset) => ({
        id: asset.id,
        fileName: asset.originalFileName,
        rating: asset.exifInfo?.rating ?? null,
        canRate: asset.ownerId === auth.user.id,
        stackCount: asset.stack?.assetCount ?? 1,
        currentRevisionId: current.get(asset.id) ?? null,
      })),
    };
  }

  async rate(auth: AuthDto, id: string, input: PhotographyRatingDto): Promise<void> {
    const safeAuth = this.session(auth);
    const dto = PhotographyRatingDto.schema.parse(input);
    const shoot = await this.shoot(safeAuth, id);
    const result = await this.search.searchMetadata(
      safeAuth,
      MetadataSearchDto.schema.parse({
        filter: {
          id: { eq: dto.assetId },
          albumIds: { any: [shoot.albumId] },
          visibility: { ne: AssetVisibility.Locked },
          type: { eq: AssetType.Image },
        },
        size: 1,
      }),
    );
    if (result.assets.items[0]?.ownerId !== auth.user.id) {
      throw new ForbiddenException('Photo is unavailable');
    }
    await this.assets.update(safeAuth, dto.assetId, { rating: dto.rating });
  }
}
