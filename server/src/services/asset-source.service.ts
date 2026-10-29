import { Injectable, NotFoundException } from '@nestjs/common';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetSourceResponseDto } from 'src/dtos/bookmark.dto.js';
import { Permission } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetSourceRepository } from 'src/repositories/asset-source.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { requireAccess } from 'src/utils/access.js';
import { asDateTimeString } from 'src/utils/date.js';

@Injectable()
export class AssetSourceService {
  constructor(
    private sources: AssetSourceRepository,
    private assets: AssetRepository,
    private access: AccessRepository,
  ) {}

  async getAll(auth: AuthDto, assetId: string): Promise<AssetSourceResponseDto[]> {
    if (auth.sharedLink) throw new NotFoundException('Asset not found');
    const asset = await this.assets.getById(assetId);
    if (!asset || asset.ownerId !== auth.user.id) throw new NotFoundException('Asset not found');
    await requireAccess(this.access, { auth, permission: Permission.AssetRead, ids: [assetId] });
    return (await this.sources.getAll(assetId)).map((source) => ({
      ...source,
      capturedAt: asDateTimeString(source.capturedAt),
      createdAt: asDateTimeString(source.createdAt),
    }));
  }
}
