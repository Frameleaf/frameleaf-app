import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AlbumResponseDto } from 'src/dtos/album.dto.js';
import { mapAsset } from 'src/dtos/asset-response.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  CaptureAlbumCreateDto,
  CaptureCancelResponseDto,
  CaptureCapabilitiesDto,
  CaptureCatalogDto,
  CaptureCommitDto,
  CaptureResponseDto,
} from 'src/dtos/capture.dto.js';
import { mapTag } from 'src/dtos/tag.dto.js';
import { LibraryScope, Permission } from 'src/enum.js';
import { CaptureReceipt, CaptureRepository } from 'src/repositories/capture.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { AlbumService } from 'src/services/album.service.js';
import { AssetUploadResourceService } from 'src/services/asset-upload-resource.service.js';
import { BookmarkService } from 'src/services/bookmark.service.js';
import { stableServerId } from 'src/utils/frameleaf-server-identity.js';

@Injectable()
export class CaptureService {
  constructor(
    private captures: CaptureRepository,
    private uploads: AssetUploadResourceService,
    private bookmarks: BookmarkService,
    private albums: AlbumService,
    private tags: TagRepository,
    private system: SystemMetadataRepository,
  ) {}

  async capabilities(auth: AuthDto): Promise<CaptureCapabilitiesDto> {
    await this.captures.assertActor(auth, undefined, Permission.CaptureCatalogRead);
    const [serverId, limits] = await Promise.all([
      stableServerId({ systemMetadataRepository: this.system }),
      this.uploads.limits(),
    ]);
    return {
      version: 1,
      serverId,
      userId: auth.user.id,
      userName: auth.user.name,
      maxFileBytes: limits.maxSize,
      captureSupported: true,
      cancellationSupported: true,
    };
  }

  async catalog(auth: AuthDto): Promise<CaptureCatalogDto> {
    const { albums, hiddenContent } = await this.captures.catalog(auth);
    const tags = await this.tags.getAll(auth.user.id, { hideLocked: true, hiddenContent });
    return { albums, tags: tags.map((tag) => mapTag(tag)) };
  }

  async createAlbum(auth: AuthDto, dto: CaptureAlbumCreateDto): Promise<AlbumResponseDto> {
    await this.captures.assertActor(auth);
    if (dto.parentId) await this.captures.assertParent(auth, dto.parentId);
    return this.albums.create(auth, { albumName: dto.name, parentId: dto.parentId, libraryScope: LibraryScope.Design });
  }

  async commit(auth: AuthDto, dto: CaptureCommitDto): Promise<CaptureResponseDto> {
    const existing = await this.captures.getCompleted(auth, dto);
    if (existing) return this.response(auth, dto, existing);
    if (dto.bookmark) await this.captures.commitBookmark(auth, dto);
    else if (dto.uploadResourceId && dto.sha256) {
      await this.uploads.commitCapture(auth, dto.uploadResourceId, dto.sha256, (tx, publish) =>
        this.captures.commitFile(tx, auth, dto, publish),
      );
    } else throw new NotFoundException('Capture unavailable');
    const receipt = await this.captures.getCompleted(auth, dto);
    if (!receipt) throw new NotFoundException('Capture unavailable');
    return this.response(auth, dto, receipt);
  }

  async cancel(auth: AuthDto, dto: CaptureCommitDto): Promise<CaptureCancelResponseDto> {
    const receipt = await this.captures.cancel(auth, dto);
    if (receipt.status !== 'cancelled')
      return {
        captureId: dto.captureId,
        status: 'already-published',
        receipt: await this.response(auth, dto, receipt),
      };
    if (dto.uploadResourceId) {
      try {
        await this.uploads.cancel(auth, dto.uploadResourceId);
      } catch (error) {
        if (!(error instanceof NotFoundException)) throw error;
      }
    }
    return { captureId: dto.captureId, status: 'cancelled' };
  }

  private async response(auth: AuthDto, dto: CaptureCommitDto, receipt: CaptureReceipt): Promise<CaptureResponseDto> {
    if (receipt.status === 'cancelled') throw new ConflictException('Capture was cancelled');
    if (receipt.kind === 'asset') {
      const asset = await this.captures.getCapturedAsset(auth, receipt.itemId);
      if (!asset) throw new NotFoundException('Capture unavailable');
      return {
        captureId: receipt.captureId,
        status: receipt.status,
        item: { kind: 'asset', asset: mapAsset(asset, { stripMetadata: true }) },
      };
    }
    if (!dto.bookmark) throw new NotFoundException('Capture unavailable');
    const bookmark = await this.bookmarks.get({ ...auth, session: undefined }, receipt.itemId);
    if (bookmark.libraryScope === LibraryScope.Personal) throw new NotFoundException('Capture unavailable');
    return {
      captureId: receipt.captureId,
      status: receipt.status,
      item: {
        kind: 'bookmark',
        bookmark: {
          ...bookmark,
          url: dto.bookmark.url,
          title: dto.bookmark.title,
          note: dto.note ?? null,
          previewAssetId: null,
        },
      },
    };
  }
}
