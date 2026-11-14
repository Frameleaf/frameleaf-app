import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { rm, stat } from 'node:fs/promises';
import { IncomingHttpHeaders } from 'node:http';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { OnEvent } from 'src/decorators.js';
import { AssetMediaSize } from 'src/dtos/asset-media.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
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
import { CacheControl, Colorspace, ImageFormat } from 'src/enum.js';
import { ConnectMediaRepository } from 'src/repositories/connect-media.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { AssetUploadResourceService } from 'src/services/asset-upload-resource.service.js';
import { AuthService } from 'src/services/auth.service.js';
import { ConnectService } from 'src/services/connect.service.js';
import { OAuthAppService } from 'src/services/oauth-app.service.js';
import { requireConnectPolicy, requireConnectScope } from 'src/utils/connect-policy.js';
import { FileDownloadResponse } from 'src/utils/file.js';
import { FrameleafVia } from 'src/utils/frameleaf-sign-in.js';
import { isLockedPath, makeWorkDir } from 'src/utils/locked-read.js';

@Injectable()
export class ConnectMediaService {
  constructor(
    private repository: ConnectMediaRepository,
    private uploads: AssetUploadResourceService,
    private media: AssetMediaService,
    private connect: ConnectService,
    private oauth: OAuthAppService,
    private authService: AuthService,
    private images: MediaRepository,
  ) {}

  @OnEvent({ name: 'NightlyDatabaseCleanup' })
  async onNightlyDatabaseCleanup() {
    const before = new Date();
    while ((await this.repository.deleteExpiredTickets(before)) === 1000) {
      // Each statement releases its batch locks; newly minted tickets are newer than this fixed cutoff.
    }
  }

  async capabilities(auth: AuthDto, via: FrameleafVia | null) {
    const limits = await this.uploads.limits();
    const quota =
      auth.user.quotaSizeInBytes === null
        ? Number.MAX_SAFE_INTEGER
        : Math.max(0, auth.user.quotaSizeInBytes - auth.user.quotaUsageInBytes);
    requireConnectPolicy(auth);
    const scopes = auth.oauthApp!.scopes;
    const acceptedUploadTypes = {
      photo: scopes.includes('photos:upload') ? CONNECT_UPLOAD_TYPES.photo : [],
      design: scopes.includes('boards:upload') ? CONNECT_UPLOAD_TYPES.design : [],
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
            { size: variant === 'thumbnail' ? AssetMediaSize.THUMBNAIL : AssetMediaSize.PREVIEW, edited: true },
            via,
          );
    if (!(file instanceof FileDownloadResponse)) throw new NotFoundException('Rendition unavailable');
    if (variant === 'display') return this.display(auth, id, file, via);
    return new FileDownloadResponse({
      ...file,
      fileName: `${id}${extname(file.fileName ?? file.path)}`,
      cacheControl: CacheControl.None,
    });
  }

  private async display(auth: AuthDto, id: string, preview: FileDownloadResponse, via: FrameleafVia | null) {
    let folder: string | undefined;
    try {
      try {
        if (
          !preview.contentType.startsWith('image/') ||
          (await isLockedPath(preview.path)) ||
          (await stat(preview.path)).size > 64 * 1024 * 1024
        ) {
          throw new NotFoundException('Display rendition unavailable');
        }
        const { width, height } = await this.images.getOrientedSize(preview.path);
        if (width < 1 || height < 1 || width * height > 40_000_000) {
          throw new NotFoundException('Display rendition unavailable');
        }
        folder = await makeWorkDir('connect-display', false);
        const output = join(folder, 'display.jpg');
        await this.images.generateThumbnail(
          preview.path,
          {
            size: 1920,
            fit: 'inside',
            colorspace: Colorspace.Srgb,
            format: ImageFormat.Jpeg,
            quality: 80,
            progressive: false,
            processInvalidImages: false,
          },
          output,
        );
        const rendered = await this.images.getOrientedSize(output);
        if (Math.max(rendered.width, rendered.height) > 1920 || (await stat(output)).size > 5 * 1024 * 1024) {
          throw new NotFoundException('Display rendition exceeds its limit');
        }
        await this.readable(auth, id, 'display', via);
        const directory = folder;
        return new FileDownloadResponse({
          path: output,
          contentType: 'image/jpeg',
          fileName: `${id}.jpg`,
          cacheControl: CacheControl.None,
          deliveryTimeout: 30_000,
          release: () => rm(directory, { recursive: true, force: true }),
        });
      } finally {
        await preview.release?.();
      }
    } catch (error) {
      if (folder) {
        await rm(folder, { recursive: true, force: true });
      }
      throw error;
    }
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
