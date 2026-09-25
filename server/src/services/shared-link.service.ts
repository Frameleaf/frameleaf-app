import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PostgresError } from 'postgres';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { SharedLink } from 'src/database.js';
import { AssetIdErrorReason, AssetIdsResponseDto } from 'src/dtos/asset-ids.response.dto.js';
import { AssetIdsDto } from 'src/dtos/asset.dto.js';
import {
  SharedLinkCreateDto,
  SharedLinkEditDto,
  SharedLinkLoginDto,
  SharedLinkResponseDto,
  SharedLinkSearchDto,
  mapSharedLink,
} from 'src/dtos/shared-link.dto.js';
import { Permission, SharedLinkType } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { type HiddenContentQueryOptions, getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { OpenGraphTags, findOrFail, getExternalDomain } from 'src/utils/misc.js';
import { applyPartnerLocationPolicy } from 'src/utils/partner-location.js';

@Injectable()
export class SharedLinkService extends BaseService {
  async getAll(auth: AuthDto, { id, albumId }: SharedLinkSearchDto): Promise<SharedLinkResponseDto[]> {
    const searchOptions = { userId: auth.user.id, id, albumId };
    const nsfwOptions = this.nsfwOptions(auth);
    const links = await this.sharedLinkRepository.getAll(
      nsfwOptions ? { ...searchOptions, ...nsfwOptions } : searchOptions,
    );
    return Promise.all(links.map((link) => this.mapSharedLink(auth, link, { stripAssetMetadata: false })));
  }

  async login(auth: AuthDto, dto: SharedLinkLoginDto) {
    if (!auth.sharedLink) {
      throw new ForbiddenException();
    }

    const sharedLink = await this.findOrFail(auth.user.id, auth.sharedLink.id, this.nsfwOptions(auth));
    const { id, password } = sharedLink;

    if (!password) {
      throw new BadRequestException('Shared link is not password protected');
    }

    if (password !== dto.password) {
      throw new UnauthorizedException('Invalid password');
    }

    return {
      sharedLink: await this.mapSharedLink(auth, sharedLink, { stripAssetMetadata: !sharedLink.showExif }),
      token: this.asToken({ id, password }),
    };
  }

  async getMine(auth: AuthDto, authTokens: string[]) {
    if (!auth.sharedLink) {
      throw new ForbiddenException();
    }

    const sharedLink = await this.findOrFail(auth.user.id, auth.sharedLink.id, this.nsfwOptions(auth));
    const { id, password } = sharedLink;

    if (password && !authTokens.includes(this.asToken({ id, password }))) {
      throw new UnauthorizedException('Password required');
    }

    return this.mapSharedLink(auth, sharedLink, { stripAssetMetadata: !sharedLink.showExif });
  }

  async get(auth: AuthDto, id: string): Promise<SharedLinkResponseDto> {
    const sharedLink = await this.findOrFail(auth.user.id, id, this.nsfwOptions(auth));
    return this.mapSharedLink(auth, sharedLink, { stripAssetMetadata: false });
  }

  async create(auth: AuthDto, dto: SharedLinkCreateDto): Promise<SharedLinkResponseDto> {
    switch (dto.type) {
      case SharedLinkType.Album: {
        if (!dto.albumId) {
          throw new BadRequestException('Invalid albumId');
        }
        await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [dto.albumId] });
        break;
      }

      case SharedLinkType.Individual: {
        if (!dto.assetIds || dto.assetIds.length === 0) {
          throw new BadRequestException('Invalid assetIds');
        }

        await this.requireAccess({ auth, permission: Permission.AssetShare, ids: dto.assetIds });
        await this.requireUnlockedAssets(auth, dto.assetIds);

        break;
      }
    }

    try {
      const sharedLink = await this.sharedLinkRepository.create({
        key: this.cryptoRepository.randomBytes(50),
        userId: auth.user.id,
        type: dto.type,
        albumId: dto.albumId || null,
        assetIds: dto.assetIds,
        description: dto.description || null,
        password: dto.password,
        expiresAt: dto.expiresAt || null,
        allowUpload: dto.allowUpload ?? true,
        allowDownload: dto.showMetadata === false ? false : (dto.allowDownload ?? true),
        showExif: dto.showMetadata ?? true,
        slug: dto.slug || null,
      });

      return mapSharedLink(sharedLink, { stripAssetMetadata: false });
    } catch (error) {
      this.handleError(error);
    }
  }

  private handleError(error: unknown): never {
    if ((error as PostgresError).constraint_name === 'shared_link_slug_uq') {
      this.logger.debug('Shared link with this slug already exists');
      throw new BadRequestException('Failed to save shared link');
    }
    throw error;
  }

  async update(auth: AuthDto, id: string, dto: SharedLinkEditDto) {
    const nsfwOptions = this.nsfwOptions(auth);
    await this.findOrFail(auth.user.id, id, nsfwOptions);
    try {
      const updatedSharedLink = await this.sharedLinkRepository.update({
        id,
        userId: auth.user.id,
        description: dto.description,
        password: dto.password,
        expiresAt: dto.expiresAt,
        allowUpload: dto.allowUpload,
        allowDownload: dto.allowDownload,
        showExif: dto.showMetadata,
        slug: dto.slug || null,
      });
      const sharedLink = nsfwOptions ? await this.findOrFail(auth.user.id, id, nsfwOptions) : updatedSharedLink;
      return this.mapSharedLink(auth, sharedLink, { stripAssetMetadata: false });
    } catch (error) {
      this.handleError(error);
    }
  }

  async remove(auth: AuthDto, id: string): Promise<void> {
    const sharedLink = await this.findOrFail(auth.user.id, id);
    await this.sharedLinkRepository.remove(sharedLink.id);
  }

  // TODO: replace `userId` with permissions and access control checks
  private findOrFail(userId: string, id: string, options?: HiddenContentQueryOptions) {
    return findOrFail(
      () => (options ? this.sharedLinkRepository.get(userId, id, options) : this.sharedLinkRepository.get(userId, id)),
      'Shared link',
    );
  }

  /**
   * A shared link never carries Locked media (owner decision, September 22, 2026). `Permission.AssetShare`
   * lets an elevated owner's Locked items through so they can go into albums, so a link has to refuse
   * them itself. Only an elevated session can get this far with Locked items, so only then is the
   * database asked.
   */
  private async lockedAssetIds(auth: AuthDto, assetIds: string[]): Promise<Set<string>> {
    if (!auth.session?.hasElevatedPermission || assetIds.length === 0) {
      return new Set();
    }

    return this.assetRepository.getLockedAssetIds(assetIds);
  }

  private async requireUnlockedAssets(auth: AuthDto, assetIds: string[]): Promise<void> {
    const lockedAssetIds = await this.lockedAssetIds(auth, assetIds);
    if (lockedAssetIds.size > 0) {
      throw new BadRequestException('Locked media cannot be put in a shared link');
    }
  }

  async addAssets(auth: AuthDto, id: string, dto: AssetIdsDto): Promise<AssetIdsResponseDto[]> {
    const [sharedLink, rawSharedLink] = await Promise.all([
      this.findOrFail(auth.user.id, id, this.nsfwOptions(auth)),
      this.findOrFail(auth.user.id, id),
    ]);
    if (sharedLink.type !== SharedLinkType.Individual) {
      throw new BadRequestException('Invalid shared link type');
    }

    const existingAssetIds = new Set(sharedLink.assets.map((asset) => asset.id));
    const rawExistingAssetIds = new Set(rawSharedLink.assets.map((asset) => asset.id));
    const notPresentAssetIds = dto.assetIds.filter((assetId) => !rawExistingAssetIds.has(assetId));
    const allowedAssetIds = await this.checkAccess({
      auth,
      permission: Permission.AssetShare,
      ids: notPresentAssetIds,
    });
    const lockedAssetIds = await this.lockedAssetIds(auth, [...allowedAssetIds]);

    const results: AssetIdsResponseDto[] = [];
    for (const assetId of dto.assetIds) {
      const hasAsset = existingAssetIds.has(assetId);
      if (hasAsset) {
        results.push({ assetId, success: false, error: AssetIdErrorReason.DUPLICATE });
        continue;
      }

      if (rawExistingAssetIds.has(assetId)) {
        results.push({ assetId, success: false, error: AssetIdErrorReason.NO_PERMISSION });
        continue;
      }

      const hasAccess = allowedAssetIds.has(assetId) && !lockedAssetIds.has(assetId);
      if (!hasAccess) {
        results.push({ assetId, success: false, error: AssetIdErrorReason.NO_PERMISSION });
        continue;
      }

      results.push({ assetId, success: true });
    }

    await this.sharedLinkRepository.update({
      ...sharedLink,
      assetIds: results.filter(({ success }) => success).map(({ assetId }) => assetId),
    });

    return results;
  }

  async removeAssets(auth: AuthDto, id: string, dto: AssetIdsDto): Promise<AssetIdsResponseDto[]> {
    const sharedLink = await this.findOrFail(auth.user.id, id, this.nsfwOptions(auth));

    if (sharedLink.type !== SharedLinkType.Individual) {
      throw new BadRequestException('Invalid shared link type');
    }

    const existingAssetIds = new Set(sharedLink.assets.map((asset) => asset.id));

    const results: AssetIdsResponseDto[] = [];
    for (const assetId of dto.assetIds) {
      if (!existingAssetIds.has(assetId)) {
        results.push({ assetId, success: false, error: AssetIdErrorReason.NOT_FOUND });
        continue;
      }

      results.push({ assetId, success: true });
    }

    const removedAssetIds = results.filter(({ success }) => success).map(({ assetId }) => assetId);
    if (removedAssetIds.length > 0) {
      await this.sharedLinkAssetRepository.remove(id, removedAssetIds);
    }

    return results;
  }

  async getMetadataTags(auth: AuthDto, defaultDomain?: string): Promise<null | OpenGraphTags> {
    if (!auth.sharedLink || auth.sharedLink.password) {
      return null;
    }

    const config = await this.getConfig({ withCache: true });
    const sharedLink = await this.applyNsfwPrivacy(
      auth,
      await this.findOrFail(auth.sharedLink.userId, auth.sharedLink.id, this.nsfwOptions(auth)),
    );
    const assetId =
      sharedLink.album?.albumThumbnailAssetId || sharedLink.album?.assets?.[0]?.id || sharedLink.assets[0]?.id;
    const assetCount = sharedLink.assets.length > 0 ? sharedLink.assets.length : sharedLink.album?.assets?.length || 0;
    const imagePath = assetId
      ? `/api/assets/${assetId}/thumbnail?key=${sharedLink.key.toString('base64url')}`
      : '/feature-panel.png';

    return {
      title: sharedLink.album ? sharedLink.album.albumName : 'Public Share',
      description: sharedLink.description || `${assetCount} shared photos & videos`,
      imageUrl: new URL(imagePath, getExternalDomain(config.server, defaultDomain)).href,
    };
  }

  private asToken(sharedLink: { id: string; password: string }) {
    return this.cryptoRepository.hashSha256(`${sharedLink.id}-${sharedLink.password}`).toString('base64');
  }

  private async mapSharedLink(
    auth: AuthDto,
    sharedLink: SharedLink,
    options: { stripAssetMetadata: boolean },
  ): Promise<SharedLinkResponseDto> {
    const response = mapSharedLink(await this.applyNsfwPrivacy(auth, sharedLink), options);
    if (options.stripAssetMetadata || response.assets.length === 0) {
      return response;
    }

    // FL-54: a link shows at most what its creator may see, so an owner who hides their locations from
    // the creator never has them handed out through the link's own assets
    const assets = await applyPartnerLocationPolicy(response.assets, {
      userId: sharedLink.userId,
      repository: this.partnerRepository,
    });
    return { ...response, assets };
  }

  private async applyNsfwPrivacy(auth: AuthDto, sharedLink: SharedLink): Promise<SharedLink> {
    const album = sharedLink.album;
    const albumThumbnailAssetId = album?.albumThumbnailAssetId;
    if (!auth.hideNsfwAssets || !albumThumbnailAssetId) {
      return sharedLink;
    }

    const nsfwThumbnailIds = await this.assetRepository.getHiddenContentAssetIds(
      [albumThumbnailAssetId],
      getHiddenContentQueryOptions(auth),
    );
    return nsfwThumbnailIds.has(albumThumbnailAssetId)
      ? {
          ...sharedLink,
          album: { ...album, albumThumbnailAssetId: null },
        }
      : sharedLink;
  }

  private nsfwOptions(auth: AuthDto) {
    return auth.hideNsfwAssets ? getHiddenContentQueryOptions(auth) : undefined;
  }
}
