import { Body, Controller, Get, Headers, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import type { Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  FinishLibrarySetupDto,
  LibrarySetupStatusDto,
  WarmLibrarySetupDto,
} from 'src/dtos/frameleaf-library-setup.dto.js';
import { ApiTag, Permission, SyncEntityType, SyncRequestType } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { FrameleafLibrarySetupService } from 'src/services/frameleaf-library-setup.service.js';
import { SyncService } from 'src/services/sync.service.js';

const history = new HistoryBuilder().added('v3.2.0').alpha('v3.2.0');

// Pin one supported version of each protocol. Enumerating the enum includes handlers retained
// only to reject obsolete clients, and sends duplicate representations of the same entities.
export const LIBRARY_SETUP_SYNC_TYPES = [
  SyncRequestType.AlbumAssetAccessV1,
  SyncRequestType.PinnedCollectionEventsV1,
  SyncRequestType.AssetTrashStatesV1,
  SyncRequestType.DuplicateGroupsV1,
  SyncRequestType.SharedSpacesV1,
  SyncRequestType.SharedSpaceMembersV1,
  SyncRequestType.SharedSpaceAlbumsV1,
  SyncRequestType.SharedSpacePeopleV1,
  SyncRequestType.PetsV1,
  SyncRequestType.PetObservationsV1,
  SyncRequestType.TagsV1,
  SyncRequestType.AssetTagsV1,
  SyncRequestType.AuthUsersV2,
  SyncRequestType.UsersV1,
  SyncRequestType.PartnersV1,
  SyncRequestType.AssetsV3,
  SyncRequestType.StacksV1,
  SyncRequestType.AlbumAssetsV2,
  SyncRequestType.AlbumsV3,
  SyncRequestType.AlbumUsersV1,
  SyncRequestType.AlbumToAssetsV1,
  SyncRequestType.AlbumSourceLinksV1,
  SyncRequestType.AssetExifsV1,
  SyncRequestType.AlbumAssetExifsV1,
  SyncRequestType.AssetOcrV1,
  SyncRequestType.MemoriesV1,
  SyncRequestType.MemoryToAssetsV1,
  SyncRequestType.PeopleV1,
  SyncRequestType.AssetFacesV3,
  SyncRequestType.UserMetadataV1,
  SyncRequestType.PinnedCollectionsV1,
  SyncRequestType.AssetMetadataV1,
  SyncRequestType.AssetEditsV1,
];

@ApiTags(ApiTag.Server)
@Controller('server/library-setup')
export class FrameleafLibrarySetupController {
  constructor(
    private setup: FrameleafLibrarySetupService,
    private sync: SyncService,
  ) {}

  @Get()
  @Authenticated({ permission: Permission.SyncStream })
  @Endpoint({
    operationId: 'getLibrarySetupStatus',
    summary: 'Library preparation for this authenticated device',
    history,
  })
  status(@Auth() auth: AuthDto): Promise<LibrarySetupStatusDto> {
    return this.setup.status(auth);
  }

  @Post('begin')
  @Authenticated({ admin: true })
  @Endpoint({ operationId: 'beginLibrarySetup', summary: 'Start the managed library rescan', history })
  async begin(): Promise<LibrarySetupStatusDto> {
    await this.setup.begin(true);
    return this.setup.status();
  }

  @Get('manager')
  @Authenticated({ public: true })
  @Endpoint({ operationId: 'getManagerLibrarySetup', summary: 'Manager machine-authenticated setup status', history })
  async managerStatus(@Headers('x-frameleaf-manager') token?: string): Promise<LibrarySetupStatusDto> {
    await this.setup.authorizeManager(token);
    return this.setup.status();
  }

  @Post('manager')
  @Authenticated({ public: true })
  @Endpoint({ operationId: 'beginManagerLibrarySetup', summary: 'Manager machine-authenticated rescan', history })
  async managerBegin(@Headers('x-frameleaf-manager') token?: string): Promise<LibrarySetupStatusDto> {
    await this.setup.authorizeManager(token);
    await this.setup.begin(true);
    return this.setup.status();
  }

  @Post('sync')
  @Authenticated({ permission: Permission.SyncStream })
  @Endpoint({ operationId: 'syncLibrarySetup', summary: 'Warm the authenticated device catalog during setup', history })
  async warm(@Auth() auth: AuthDto, @Body() dto: WarmLibrarySetupDto, @Res() response: Response) {
    const status = await this.setup.status(auth);
    response.setHeader('Content-Type', 'application/jsonlines+json');
    let complete = false;
    const sink = new Writable({
      write: (chunk, _encoding, callback) => {
        // SyncService writes one NDJSON message at a time. Only its final marker earns a receipt.
        try {
          if (JSON.parse(String(chunk)).type === SyncEntityType.SyncCompleteV1) {
            complete = true;
          }
        } catch {
          /* no marker */
        }
        if (response.destroyed) {
          return callback(new Error('Client disconnected'));
        }
        if (response.write(chunk)) {
          callback();
        } else {
          response.once('drain', callback);
        }
      },
    });
    const disconnected = () => {
      if (!response.writableFinished) {
        sink.destroy(new Error('Client disconnected'));
      }
    };
    response.once('close', disconnected);
    sink.on('error', () => {
      if (!response.destroyed) {
        response.destroy();
      }
    });
    const flushed = finished(sink);
    void flushed.catch(() => {});
    try {
      await this.sync.stream(auth, sink, { types: LIBRARY_SETUP_SYNC_TYPES, reset: dto.reset });
      await flushed;
      if (complete && status.revision && status.phase === 'complete' && !response.destroyed) {
        const receipt = await this.setup.syncReceipt(auth, status.revision);
        response.write(JSON.stringify({ type: 'FrameleafSetupRevisionV1', revision: status.revision, receipt }) + '\n');
      }
      response.end();
    } catch {
      response.destroy();
    } finally {
      response.off('close', disconnected);
    }
  }

  @Post('finish')
  @Authenticated({ permission: Permission.SyncStream })
  @Endpoint({
    operationId: 'finishLibrarySetup',
    summary: 'Finish after catalog and browsing previews are cached',
    history,
  })
  finish(@Auth() auth: AuthDto, @Body() dto: FinishLibrarySetupDto): Promise<LibrarySetupStatusDto> {
    return this.setup.finish(auth, dto.revision, dto.receipt, dto.previewsReady);
  }
}
