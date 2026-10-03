import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { PhotographyRenditionPreviewDto } from 'src/dtos/photography-rendition.dto.js';
import {
  type PhotographyBrand,
  PhotographyBrandDto,
  PhotographyBrandSaveDto,
  PhotographyBrandSchema,
  PhotographyLogoCandidatesDto,
  PhotographyPhotoQueryDto,
  PhotographyPhotosDto,
  PhotographyRatingDto,
  PhotographyWorkspaceDto,
  PhotographyWorkspaceSaveDto,
  type StoredShoot,
} from 'src/dtos/photography-workspace.dto.js';
import { MetadataSearchDto } from 'src/dtos/search.dto.js';
import { AlbumKind, AssetType, AssetVisibility, CacheControl } from 'src/enum.js';
import { PhotographyWorkspaceRepository } from 'src/repositories/photography-workspace.repository.js';
import { AlbumService } from 'src/services/album.service.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { AssetService } from 'src/services/asset.service.js';
import { SearchService } from 'src/services/search.service.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import {
  preparePhotographyLogo,
  readPhotographyLogo,
  renderPhotographyRendition,
} from 'src/utils/photography-rendition.js';

@Injectable()
export class PhotographyWorkspaceService {
  constructor(
    private repository: PhotographyWorkspaceRepository,
    private albums: AlbumService,
    private search: SearchService,
    private assets: AssetService,
    private media: AssetMediaService,
  ) {}

  private session(auth: AuthDto): AuthDto {
    if (!auth.session || auth.sharedLink || auth.apiKey) {
      throw new ForbiddenException('Photography requires a user session');
    }
    // Photography never surfaces Locked content, even while the owner's PIN session is elevated.
    return { ...auth, session: { ...auth.session, hasElevatedPermission: false } };
  }

  private defaultBrand(auth: AuthDto): PhotographyBrand {
    return PhotographyBrandSchema.parse({
      name: auth.user.name,
      tagline: '',
      email: '',
      phone: '',
      logoInitials: '',
      logoAssetId: null,
      color: '#577059',
      background: '#f5f3ed',
      textColor: '#263329',
      font: 'editorial',
      watermarkColor: '#ffffff',
      watermarkOpacity: 45,
      watermarkPosition: 'bottom-right',
      watermarkSize: 6,
    });
  }

  private async logo(auth: AuthDto, id: string) {
    const result = await this.search.searchMetadata(
      auth,
      MetadataSearchDto.schema.parse({
        filter: {
          id: { eq: id },
          type: { eq: AssetType.Image },
          visibility: { ne: AssetVisibility.Locked },
          fileSizeInBytes: { lte: 512_000 },
          trashedAt: { eq: null },
        },
        size: 1,
      }),
    );
    const asset = result.assets.items[0];
    if (
      !asset ||
      asset.ownerId !== auth.user.id ||
      asset.type !== AssetType.Image ||
      asset.visibility === AssetVisibility.Locked ||
      asset.isTrashed ||
      asset.isOffline ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(asset.originalMimeType ?? '')
    ) {
      throw new ForbiddenException('Logo is unavailable');
    }
    return readPhotographyLogo(asset.originalPath);
  }

  private async brandView(
    auth: AuthDto,
    brand: PhotographyBrand,
    revision: string | null,
  ): Promise<PhotographyBrandDto> {
    brand = PhotographyBrandSchema.parse(brand);
    let logoUnavailable = false;
    const unavailable = new Set<string>();
    const ids = new Set([brand.logoAssetId, ...brand.watermarkPresets.map(({ watermark }) => watermark.logoAssetId)]);
    for (const id of ids) {
      if (!id) continue;
      try {
        await this.logo(auth, id);
      } catch (error) {
        if (!(error instanceof HttpException) || ![400, 403, 404].includes(error.getStatus())) throw error;
        unavailable.add(id);
        logoUnavailable = true;
      }
    }
    return {
      revision,
      brand: {
        ...brand,
        logoAssetId: brand.logoAssetId && unavailable.has(brand.logoAssetId) ? null : brand.logoAssetId,
        watermarkPresets: brand.watermarkPresets.map((preset) => ({
          ...preset,
          watermark: {
            ...preset.watermark,
            logoAssetId:
              preset.watermark.logoAssetId && unavailable.has(preset.watermark.logoAssetId)
                ? null
                : preset.watermark.logoAssetId,
          },
        })),
      },
      logoUnavailable,
    };
  }

  async getBrand(auth: AuthDto): Promise<PhotographyBrandDto> {
    const safeAuth = this.session(auth);
    const stored = await this.repository.get(auth.user.id);
    return this.brandView(safeAuth, stored?.value.brand ?? this.defaultBrand(auth), stored?.updateId ?? null);
  }

  async saveBrand(auth: AuthDto, input: PhotographyBrandSaveDto): Promise<PhotographyBrandDto> {
    const safeAuth = this.session(auth);
    const dto = PhotographyBrandSaveDto.schema.parse(input);
    const stored = await this.repository.get(auth.user.id);
    if ((stored?.updateId ?? null) !== dto.expectedRevision) {
      throw new ConflictException('Branding changed; reload before saving');
    }
    const previous = stored?.value.brand ? PhotographyBrandSchema.parse(stored.value.brand) : this.defaultBrand(auth);
    const supplied = dto.brand;
    const brand: PhotographyBrand = {
      ...dto.brand,
      logoAssetId: dto.brand.logoAssetId === undefined ? previous.logoAssetId : dto.brand.logoAssetId,
      watermarkPresets: supplied.watermarkPresets === undefined ? previous.watermarkPresets : supplied.watermarkPresets,
      webWatermarkPresetId:
        supplied.webWatermarkPresetId === undefined ? previous.webWatermarkPresetId : supplied.webWatermarkPresetId,
      proofWatermarkPresetId:
        supplied.proofWatermarkPresetId === undefined
          ? previous.proofWatermarkPresetId
          : supplied.proofWatermarkPresetId,
      exportWatermarkPresetId:
        supplied.exportWatermarkPresetId === undefined
          ? previous.exportWatermarkPresetId
          : supplied.exportWatermarkPresetId,
    };
    if (new Set(brand.watermarkPresets.map(({ id }) => id)).size !== brand.watermarkPresets.length)
      throw new BadRequestException('Duplicate watermark presets');
    for (const id of [brand.webWatermarkPresetId, brand.proofWatermarkPresetId, brand.exportWatermarkPresetId]) {
      if (id && brand.watermarkPresets.every((preset) => preset.id !== id))
        throw new BadRequestException('Unknown watermark preset default');
    }
    brand.watermarkPresets = brand.watermarkPresets.map((preset) => {
      const old = previous.watermarkPresets.find(({ id }) => id === preset.id);
      if (preset.version !== (old?.version ?? 1))
        throw new ConflictException('Watermark preset changed; reload before saving');
      const changed =
        old && (old.name !== preset.name || JSON.stringify(old.watermark) !== JSON.stringify(preset.watermark));
      return { ...preset, version: changed ? old.version + 1 : preset.version };
    });
    // Omitted presets retain unavailable references privately, just like the legacy flat logo.
    if (supplied.watermarkPresets !== undefined) {
      for (const { watermark } of brand.watermarkPresets) {
        if (watermark.logoAssetId) await this.logo(safeAuth, watermark.logoAssetId);
      }
    }
    if (brand.logoAssetId) {
      try {
        await this.logo(safeAuth, brand.logoAssetId);
      } catch (error) {
        // An omitted inaccessible reference is retained privately, never hydrated or served.
        if (
          dto.brand.logoAssetId !== undefined ||
          !(error instanceof HttpException) ||
          ![400, 403, 404].includes(error.getStatus())
        ) {
          throw error;
        }
      }
    }
    const saved = await this.repository.saveBrand(auth.user.id, brand, dto.expectedRevision);
    if (!saved) {
      throw new ConflictException('Branding changed; reload before saving');
    }
    return this.brandView(safeAuth, brand, saved.updateId);
  }

  async logos(auth: AuthDto, query: PhotographyPhotoQueryDto): Promise<PhotographyLogoCandidatesDto> {
    const safeAuth = this.session(auth);
    const result = await this.search.searchMetadata(
      safeAuth,
      MetadataSearchDto.schema.parse({
        filter: {
          type: { eq: AssetType.Image },
          visibility: { ne: AssetVisibility.Locked },
          fileSizeInBytes: { lte: 512_000 },
          trashedAt: { eq: null },
        },
        cursor: query.cursor,
        size: 80,
      }),
    );
    return {
      nextCursor: result.assets.nextCursor ?? null,
      logos: result.assets.items
        .filter(
          (asset) =>
            asset.ownerId === auth.user.id &&
            asset.type === AssetType.Image &&
            asset.visibility !== AssetVisibility.Locked &&
            !asset.isTrashed &&
            !asset.isOffline &&
            ['image/png', 'image/jpeg', 'image/webp'].includes(asset.originalMimeType ?? ''),
        )
        .map(({ id, originalFileName }) => ({ id, fileName: originalFileName })),
    };
  }

  async logoBytes(auth: AuthDto, id: string): Promise<Buffer> {
    return this.logo(this.session(auth), id);
  }

  async logoThumbnail(
    auth: AuthDto,
    id: string,
    variant: 'original' | 'light' | 'dark' = 'original',
  ): Promise<ImmichFileResponse> {
    const variants = await preparePhotographyLogo(await this.logoBytes(auth, id));
    const directory = await mkdtemp(join(tmpdir(), 'frameleaf-logo-'));
    try {
      const path = join(directory, 'logo.png');
      await writeFile(path, variants[variant]);
      return new ImmichFileResponse({
        path,
        contentType: 'image/png',
        fileName: 'studio-logo',
        cacheControl: CacheControl.None,
        release: () => {
          void rm(directory, { recursive: true, force: true });
        },
      });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async previewWatermark(auth: AuthDto, input: PhotographyRenditionPreviewDto): Promise<Buffer> {
    const safeAuth = this.session(auth);
    const dto = PhotographyRenditionPreviewDto.schema.parse(input);
    const width = dto.orientation === 'portrait' ? 480 : 720,
      height = dto.orientation === 'portrait' ? 720 : 480;
    const source = await sharp({
      create: { width, height, channels: 3, background: dto.background === 'light' ? '#e8e4dc' : '#263329' },
    })
      .png()
      .toBuffer();
    const logo = dto.watermark.logoAssetId ? await this.logoBytes(safeAuth, dto.watermark.logoAssetId) : undefined;
    return renderPhotographyRendition(source, dto.watermark, logo);
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
        camera: [asset.exifInfo?.make, asset.exifInfo?.model].filter(Boolean).join(' '),
        capturedAt: asset.exifInfo?.dateTimeOriginal ?? asset.fileCreatedAt ?? null,
        isRaw: mimeTypes.isRaw(asset.originalFileName),
        stackId: asset.stack?.id ?? null,
        width: asset.exifInfo?.exifImageWidth ?? null,
        height: asset.exifInfo?.exifImageHeight ?? null,
        eligible:
          asset.ownerId === auth.user.id && !asset.isOffline && !asset.isTrashed && asset.exifInfo?.rating !== -1,
        exclusion:
          asset.ownerId === auth.user.id
            ? asset.isOffline
              ? 'offline'
              : asset.isTrashed
                ? 'trashed'
                : asset.exifInfo?.rating === -1
                  ? 'rejected'
                  : null
            : 'foreign',
        processing: asset.isOffline ? 'failed' : asset.thumbhash ? 'ready' : 'pending',
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
