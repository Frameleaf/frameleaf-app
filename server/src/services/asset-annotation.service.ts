import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AssetAnnotationsDto, AssetAnnotationsUpdateDto } from 'src/dtos/asset-annotation.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetType, Permission } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import {
  AnnotatedAsset,
  AssetAnnotationRepository,
  StoredAnnotations,
  isBoardsScope,
} from 'src/repositories/asset-annotation.repository.js';
import { requireAccess } from 'src/utils/access.js';

/** Annotations belong to Boards pictures: images whose scope is Design or Both. */
const isAnnotatable = (asset: AnnotatedAsset) => asset.type === AssetType.Image && isBoardsScope(asset.libraryScope);

/**
 * FL-652: Boards annotations. Anyone who may see the picture may read them (the owner, partners,
 * shared albums and shared links). Only the owner, signed in, may replace them. Saving writes the
 * annotation document alone: the original file never changes and no edit runs.
 */
@Injectable()
export class AssetAnnotationService {
  constructor(
    private annotations: AssetAnnotationRepository,
    private access: AccessRepository,
  ) {}

  async get(auth: AuthDto, id: string): Promise<AssetAnnotationsDto> {
    await requireAccess(this.access, { auth, permission: Permission.AssetRead, ids: [id] });
    const asset = await this.annotations.getAsset(id);
    if (!asset) {
      throw new NotFoundException('Asset not found');
    }
    // A picture that is only in Photos has no Boards annotations to show, even if it once had some.
    const stored = isAnnotatable(asset) ? await this.annotations.get(id) : undefined;
    return this.toDto(auth, asset, stored);
  }

  async replace(auth: AuthDto, id: string, dto: AssetAnnotationsUpdateDto): Promise<AssetAnnotationsDto> {
    if (auth.sharedLink) {
      throw new ForbiddenException('Only the owner can change annotations');
    }
    await requireAccess(this.access, { auth, permission: Permission.AssetUpdate, ids: [id] });
    const asset = await this.annotations.getAsset(id);
    if (!asset) {
      throw new NotFoundException('Asset not found');
    }
    if (asset.ownerId !== auth.user.id) {
      throw new ForbiddenException('Only the owner can change annotations');
    }
    if (!isAnnotatable(asset)) {
      throw new BadRequestException('Annotations are for pictures in Boards');
    }
    const stored = await this.annotations.replace(id, dto.items, dto.sourceRevision);
    if (stored === 'conflict') {
      // the picture changed after these positions were read: never stamp them as fitting the new one
      throw new ConflictException('The picture changed after its annotations were read');
    }
    if (!stored && dto.items.length > 0) {
      throw new NotFoundException('Asset not found');
    }
    return this.toDto(auth, asset, stored);
  }

  private toDto(auth: AuthDto, asset: AnnotatedAsset, stored?: StoredAnnotations): AssetAnnotationsDto {
    return {
      version: 1,
      sourceRevision: stored?.sourceRevision ?? asset.sourceRevision,
      sourceChanged: !!stored && stored.sourceRevision !== asset.sourceRevision,
      canEdit: !auth.sharedLink && asset.ownerId === auth.user.id && isAnnotatable(asset),
      items: stored?.items ?? [],
      updatedAt: stored ? stored.updatedAt.toISOString() : null,
    };
  }
}
