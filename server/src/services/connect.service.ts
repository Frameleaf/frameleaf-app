import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { ConnectAddAssetsDto, ConnectAddTagsDto, ConnectSearchDto } from 'src/dtos/connect.dto.js';
import { ConnectRepository } from 'src/repositories/connect.repository.js';
import { AlbumService } from 'src/services/album.service.js';
import { BaseService } from 'src/services/base.service.js';
import { TagService } from 'src/services/tag.service.js';
import { ConnectWorkspace, requireConnectPolicy, requireConnectScope } from 'src/utils/connect-policy.js';
import { stableServerId } from 'src/utils/frameleaf-server-identity.js';

@Injectable()
export class ConnectService extends BaseService {
  @Inject(ConnectRepository)
  private connectRepository!: ConnectRepository;
  @Inject(AlbumService)
  private albumService!: AlbumService;
  @Inject(TagService)
  private tagService!: TagService;

  async capabilities(auth: AuthDto) {
    const accessPolicy = requireConnectPolicy(auth);
    return {
      protocolVersion: 1 as const,
      server: {
        id: await stableServerId({ systemMetadataRepository: this.systemMetadataRepository }),
        name: 'Frameleaf',
      },
      displayIdentity: { name: auth.user.name },
      connection: { grantId: auth.oauthApp!.grantId, libraryUserId: auth.user.id },
      scopes: auth.oauthApp!.scopes,
      accessPolicy,
      policyRevision: auth.oauthApp!.policyRevision ?? 0,
      albums: await this.connectRepository.albums(auth),
      limits: { maxPageSize: 100 as const },
      supportedTypes: { read: ['IMAGE', 'VIDEO'], upload: { photo: [], design: [] } },
    };
  }

  async albums(auth: AuthDto) {
    requireConnectPolicy(auth);
    return { items: await this.connectRepository.albums(auth) };
  }

  async search(auth: AuthDto, dto: ConnectSearchDto) {
    requireConnectScope(auth, 'library:read');
    if (
      dto.albumId &&
      !(await this.connectRepository.albums(auth)).some((album) => album.id === dto.albumId && album.canRead)
    )
      throw new ForbiddenException('Album is not readable');
    return this.connectRepository.search(auth, dto);
  }

  async asset(auth: AuthDto, id: string) {
    requireConnectScope(auth, 'library:read');
    return this.connectRepository.asset(auth, id);
  }

  requireReadableAssets(auth: AuthDto, ids: string[]) {
    return this.connectRepository.requireReadableAssets(auth, ids);
  }
  requireWritableAlbum(auth: AuthDto, id: string) {
    return this.connectRepository.requireWritableAlbum(auth, id);
  }
  requireWorkspace(auth: AuthDto, workspace: ConnectWorkspace) {
    if (!requireConnectPolicy(auth).writeWorkspaces.includes(workspace))
      throw new ForbiddenException('Workspace is not writable');
  }

  async addAssets(auth: AuthDto, id: string, dto: ConnectAddAssetsDto) {
    return this.connectRepository.withGrantWrite(auth, async (current) => {
      requireConnectScope(current, 'albums:write');
      await this.connectRepository.requireWritableAlbum(current, id);
      await this.connectRepository.requireReadableAssets(current, dto.assetIds);
      return this.albumService.addAssets(current, id, { ids: dto.assetIds });
    });
  }

  async addTags(auth: AuthDto, id: string, dto: ConnectAddTagsDto) {
    return this.connectRepository.withGrantWrite(auth, async (current) => {
      requireConnectScope(current, 'tags:write');
      await this.connectRepository.requireReadableAssets(current, [id], true);
      const tagIds: string[] = [];
      for (const name of new Set(dto.tags)) {
        const tag = await this.tagService.create(current, { name });
        const results = await this.tagService.addAssets(current, tag.id, { ids: [id] });
        if (!results.every((result) => result.success || result.error === 'duplicate'))
          throw new ForbiddenException('Asset could not be tagged');
        tagIds.push(tag.id);
      }
      return { tagIds };
    });
  }
}
