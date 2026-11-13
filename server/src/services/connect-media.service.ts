import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { extname } from 'node:path';
import { IncomingHttpHeaders } from 'node:http';
import { Readable } from 'node:stream';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetMediaSize } from 'src/dtos/asset-media.dto.js';
import {
  CONNECT_RECEIPT_SECONDS,
  CONNECT_TICKET_SECONDS,
  CONNECT_UPLOAD_TYPES,
  ConnectAlbumCreateDto,
  ConnectRenditionDto,
  ConnectUploadCommitDto,
  ConnectUploadStartDto,
  ConnectUploadStateDto,
} from 'src/dtos/connect-media.dto.js';
import { CacheControl } from 'src/enum.js';
import { ConnectMediaRepository } from 'src/repositories/connect-media.repository.js';
import { AssetUploadResourceService } from 'src/services/asset-upload-resource.service.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { AuthService } from 'src/services/auth.service.js';
import { ConnectService } from 'src/services/connect.service.js';
import { OAuthAppService } from 'src/services/oauth-app.service.js';
import { requireConnectPolicy, requireConnectScope } from 'src/utils/connect-policy.js';
import { FileDownloadResponse } from 'src/utils/file.js';
import { FrameleafVia } from 'src/utils/frameleaf-sign-in.js';

@Injectable()
export class ConnectMediaService {
  constructor(
    private repository: ConnectMediaRepository,
    private uploads: AssetUploadResourceService,
    private media: AssetMediaService,
    private connect: ConnectService,
    private oauth: OAuthAppService,
    private authService: AuthService,
  ) {}

  async capabilities(auth: AuthDto, via: FrameleafVia | null) {
    const limits = await this.uploads.limits();
    const quota =
      auth.user.quotaSizeInBytes === null
        ? Number.MAX_SAFE_INTEGER
        : Math.max(0, auth.user.quotaSizeInBytes - auth.user.quotaUsageInBytes);
    const policy = requireConnectPolicy(auth);
    const scopes = auth.oauthApp!.scopes;
    const acceptedUploadTypes = {
      photo:
        scopes.includes('photos:upload') && policy.writeWorkspaces.includes('photo') ? CONNECT_UPLOAD_TYPES.photo : [],
      design:
        scopes.includes('boards:upload') && policy.writeWorkspaces.includes('design')
          ? CONNECT_UPLOAD_TYPES.design
          : [],
    };
    const maxUploadBytes =
      acceptedUploadTypes.photo.length + acceptedUploadTypes.design.length > 0 ? Math.min(limits.maxSize, quota) : 0;
    return {
      maxUploadBytes,
      maxAppendBytes: Math.min(limits.maxAppendSize, maxUploadBytes),
      uploadExpiresAfterSeconds: limits.maxAge,
      receiptWindowSeconds: CONNECT_RECEIPT_SECONDS,
      renditionTicketSeconds: CONNECT_TICKET_SECONDS,
      originalsAllowed:
        scopes.includes('library:read') &&
        scopes.includes('library:download') &&
        (await this.media.fullSizeAllowed(via)),
      acceptedUploadTypes,
    };
  }

  createAlbum(auth: AuthDto, dto: ConnectAlbumCreateDto) {
    return this.repository.createAlbum(auth, dto);
  }

  async start(auth: AuthDto, dto: ConnectUploadStartDto) {
    const row = await this.repository.start(auth, dto, (await this.uploads.limits()).maxSize);
    return this.state(auth, row.id);
  }

  async state(auth: AuthDto, id: string): Promise<ConnectUploadStateDto> {
    const { resource, receipt } = await this.repository.state(auth, id);
    return {
      id,
      offset: Number(resource.offset),
      size: Number(resource.expectedSize),
      state: resource.state as ConnectUploadStateDto['state'],
      expiresAt: resource.expiresAt.toISOString(),
      ...(receipt && { receipt }),
    };
  }

  async append(auth: AuthDto, id: string, headers: IncomingHttpHeaders, input: Readable) {
    const state = await this.state(auth, id);
    if (state.state === 'published' || state.state === 'cancelled') throw new ConflictException('Upload is closed');
    await this.uploads.append(auth, id, headers, input);
    return this.state(auth, id);
  }

  async commit(auth: AuthDto, id: string, dto: ConnectUploadCommitDto) {
    const { resource, receipt } = await this.repository.state(auth, id);
    if (
      resource.metadata.connect?.requestId !== dto.requestId ||
      resource.expectedChecksum.toString('hex') !== dto.sha256
    )
      throw new ConflictException('Request ID payload changed');
    if (receipt) return receipt;
    return this.uploads.commitConnect(auth, id, dto);
  }

  async cancel(auth: AuthDto, id: string) {
    const state = await this.state(auth, id);
    if (state.state === 'published') return state;
    if (state.state !== 'cancelled') await this.uploads.cancel(auth, id);
    return this.state(auth, id);
  }

  private async readable(auth: AuthDto, id: string, variant: ConnectRenditionDto['variant'], via: FrameleafVia | null) {
    requireConnectScope(auth, 'library:read');
    if (variant === 'original') {
      requireConnectScope(auth, 'library:download');
      await this.authService.requireOriginalTransfer(via, '/api/connect/assets/:id/rendition');
    }
    await this.connect.requireReadableAssets(auth, [id]);
  }

  async rendition(
    auth: AuthDto,
    id: string,
    variant: ConnectRenditionDto['variant'],
    via: FrameleafVia | null,
  ): Promise<FileDownloadResponse> {
    await this.readable(auth, id, variant, via);
    const file =
      variant === 'original'
        ? await this.media.downloadOriginal(auth, id, {})
        : await this.media.viewThumbnail(
            auth,
            id,
            { size: variant === 'preview' ? AssetMediaSize.PREVIEW : AssetMediaSize.THUMBNAIL, edited: true },
            via,
          );
    if (!(file instanceof FileDownloadResponse)) throw new NotFoundException('Rendition unavailable');
    return new FileDownloadResponse({
      ...file,
      fileName: `${id}${extname(file.fileName ?? file.path)}`,
      cacheControl: CacheControl.None,
    });
  }

  async createTicket(auth: AuthDto, id: string, variant: ConnectRenditionDto['variant'], via: FrameleafVia | null) {
    await this.readable(auth, id, variant, via);
    return this.repository.createTicket(auth, id, variant);
  }

  async ticket(token: string, via: FrameleafVia | null) {
    const ticket = await this.repository.ticket(token);
    let auth = await this.oauth.validatePreviewGrant(ticket.grantId);
    auth = await this.authService.authorizeConnectGrant(auth, auth.oauthApp!.resource!, via);
    return this.rendition(auth, ticket.assetId, ticket.variant, via);
  }
}
