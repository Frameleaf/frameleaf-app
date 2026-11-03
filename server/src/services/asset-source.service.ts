import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetAddedDateDto, AssetSourceImportDto, AssetSourceResponseDto } from 'src/dtos/bookmark.dto.js';
import { LibraryScope, Permission } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetSourceRepository } from 'src/repositories/asset-source.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { requireAccess } from 'src/utils/access.js';
import { asDateTimeString } from 'src/utils/date.js';

type SourceRow = Awaited<ReturnType<AssetSourceRepository['getAll']>>[number];

const toResponse = (source: SourceRow): AssetSourceResponseDto => ({
  ...source,
  capturedAt: asDateTimeString(source.capturedAt),
  createdAt: asDateTimeString(source.createdAt),
  importedFrom: source.importedFrom ?? null,
});

@Injectable()
export class AssetSourceService {
  constructor(
    private sources: AssetSourceRepository,
    private assets: AssetRepository,
    private access: AccessRepository,
  ) {}

  async getAll(auth: AuthDto, assetId: string): Promise<AssetSourceResponseDto[]> {
    await this.requireOwned(auth, assetId, Permission.AssetRead);
    return (await this.sources.getAll(assetId)).map((source) => toResponse(source));
  }

  /** FL-653: an imported web address becomes the item's Source › Page. Only the owner can add one. */
  async addImported(auth: AuthDto, assetId: string, dto: AssetSourceImportDto): Promise<AssetSourceResponseDto> {
    const asset = await this.requireOwned(auth, assetId, Permission.AssetUpdate);
    if (asset.deletedAt) throw new NotFoundException('Asset not found');
    const source = await this.sources.addImported({
      assetId,
      importedFrom: dto.importedFrom,
      pageUrl: dto.pageUrl,
      title: dto.title?.trim() ?? '',
    });
    return toResponse(source);
  }

  /**
   * FL-653: an import sets when an item was added, such as when it was last changed in Eagle. Only
   * the owner can, only for an item in Boards only (one shown in Photos too keeps its date), only to
   * a time in the past, and only earlier than it is now: an item never moves to look newly added.
   */
  async setAddedDate(auth: AuthDto, assetId: string, dto: AssetAddedDateDto): Promise<void> {
    const asset = await this.requireOwned(auth, assetId, Permission.AssetUpdate);
    const addedAt = new Date(dto.addedAt);
    if (!(addedAt.getTime() > 0) || addedAt.getTime() >= Date.now()) {
      throw new BadRequestException('The Added date must be in the past');
    }
    if (asset.deletedAt) throw new NotFoundException('Asset not found');
    if (asset.libraryScope !== LibraryScope.Design) {
      throw new BadRequestException('Only an item in Boards only can have its Added date changed');
    }
    if (new Date(asset.createdAt).getTime() < addedAt.getTime()) {
      throw new BadRequestException('The Added date can only move earlier');
    }
    const moved = await this.sources.moveAddedDateEarlier({ assetId, ownerId: auth.user.id, addedAt });
    if (!moved) throw new BadRequestException('The Added date could not be changed');
  }

  /** The asset, when it is the caller's own: anyone else, and shared links, are told it isn't there. */
  private async requireOwned(auth: AuthDto, assetId: string, permission: Permission) {
    if (auth.sharedLink) throw new NotFoundException('Asset not found');
    const asset = await this.assets.getById(assetId);
    if (!asset || asset.ownerId !== auth.user.id) throw new NotFoundException('Asset not found');
    await requireAccess(this.access, { auth, permission, ids: [assetId] });
    return asset;
  }
}
