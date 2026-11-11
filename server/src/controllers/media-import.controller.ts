import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  MediaCapabilitiesDto,
  MediaConnectionCreateDto,
  MediaConnectionListDto,
  MediaConnectionRefreshDto,
  MediaConnectionResponseDto,
  MediaImportCreateDto,
  MediaImportListDto,
  MediaImportResponseDto,
  MediaInspectDto,
  MediaRetryDto,
  MediaSubscriptionCreateDto,
  MediaSubscriptionListDto,
  MediaSubscriptionResponseDto,
  MediaSubscriptionUpdateDto,
} from 'src/dtos/media-import.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { MediaImportService } from 'src/services/media-import.service.js';

const history = () => new HistoryBuilder().added('v3');
const secure = (request: Request) => {
  if (!request.secure) throw new ForbiddenException('Use HTTPS to share site access with Library');
};

@ApiTags(ApiTag.Capture)
@Controller('media-imports')
export class MediaImportController {
  constructor(private service: MediaImportService) {}
  @Get('capabilities')
  @Authenticated({ permission: Permission.CaptureCatalogRead })
  @Endpoint({ summary: 'Discover installed media extraction and feed capabilities', history: history() })
  getMediaCapabilities(@Auth() auth: AuthDto): Promise<MediaCapabilitiesDto> {
    return this.service.capabilities(auth);
  }

  @Post('inspect')
  @HttpCode(200)
  @Authenticated({ permission: Permission.MediaImportCreate })
  @Endpoint({ summary: 'Inspect URLs without downloading a whole account', history: history() })
  inspectMedia(@Auth() auth: AuthDto, @Body() dto: MediaInspectDto): Promise<MediaImportResponseDto> {
    return this.service.inspect(auth, dto);
  }

  @Post()
  @Authenticated({ permission: Permission.MediaImportCreate })
  @Endpoint({ summary: 'Download selected inspected media into Boards', history: history() })
  createMediaImport(@Auth() auth: AuthDto, @Body() dto: MediaImportCreateDto): Promise<MediaImportResponseDto> {
    return this.service.create(auth, dto);
  }

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.MediaImportRead })
  @Endpoint({ summary: 'List media imports for this account', history: history() })
  getMediaImports(@Auth() auth: AuthDto): Promise<MediaImportListDto> {
    return this.service.list(auth);
  }

  @Get(':id')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.MediaImportRead })
  @Endpoint({ summary: 'Get media import progress and saved items', history: history() })
  getMediaImport(@Auth() auth: AuthDto, @Param('id', new ParseUUIDPipe()) id: string): Promise<MediaImportResponseDto> {
    return this.service.get(auth, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Authenticated({ permission: Permission.MediaImportUpdate })
  @Endpoint({ summary: 'Cancel unfinished media import work', history: history() })
  cancelMediaImport(
    @Auth() auth: AuthDto,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<MediaImportResponseDto> {
    return this.service.cancel(auth, id);
  }

  @Post(':id/retry')
  @HttpCode(200)
  @Authenticated({ permission: Permission.MediaImportUpdate })
  @Endpoint({ summary: 'Retry failed media import items idempotently', history: history() })
  retryMediaImport(
    @Auth() auth: AuthDto,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: MediaRetryDto,
  ): Promise<MediaImportResponseDto> {
    return this.service.retry(auth, id, dto.idempotencyKey);
  }
}

@ApiTags(ApiTag.Capture)
@Controller('media-connections')
export class MediaConnectionController {
  constructor(private service: MediaImportService) {}
  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.MediaConnectionRead })
  @Endpoint({ summary: 'List connected site metadata without credentials', history: history() })
  getMediaConnections(@Auth() auth: AuthDto): Promise<MediaConnectionListDto> {
    return this.service.connections(auth);
  }

  @Post()
  @Authenticated({ permission: Permission.MediaConnectionWrite })
  @Endpoint({ summary: 'Share selected site access with Library over HTTPS', history: history() })
  createMediaConnection(
    @Auth() auth: AuthDto,
    @Req() request: Request,
    @Body() dto: MediaConnectionCreateDto,
  ): Promise<MediaConnectionResponseDto> {
    secure(request);
    return this.service.connect(auth, dto);
  }

  @Post(':id/refresh')
  @HttpCode(200)
  @Authenticated({ permission: Permission.MediaConnectionWrite })
  @Endpoint({ summary: 'Replace and revoke the previous site session', history: history() })
  refreshMediaConnection(
    @Auth() auth: AuthDto,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: Request,
    @Body() dto: MediaConnectionRefreshDto,
  ): Promise<MediaConnectionResponseDto> {
    secure(request);
    return this.service.refresh(auth, id, dto);
  }

  @Delete(':id')
  @Authenticated({ permission: Permission.MediaConnectionWrite })
  @Endpoint({ summary: 'Revoke site access and dependent work', history: history() })
  disconnectMediaConnection(
    @Auth() auth: AuthDto,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<MediaConnectionResponseDto> {
    return this.service.disconnect(auth, id);
  }
}

@ApiTags(ApiTag.Capture)
@Controller('media-subscriptions')
export class MediaSubscriptionController {
  constructor(private service: MediaImportService) {}
  @Post('preview')
  @HttpCode(200)
  @Authenticated({ permission: Permission.MediaSubscriptionWrite })
  @Endpoint({ summary: 'Resolve creator and feed capability before subscribing', history: history() })
  previewMediaSubscription(@Auth() auth: AuthDto, @Body() dto: MediaInspectDto): Promise<MediaImportResponseDto> {
    return this.service.inspect(auth, dto, true);
  }

  @Post()
  @Authenticated({ permission: Permission.MediaSubscriptionWrite })
  @Endpoint({ summary: 'Create a private creator collection and scheduled subscription', history: history() })
  createMediaSubscription(
    @Auth() auth: AuthDto,
    @Body() dto: MediaSubscriptionCreateDto,
  ): Promise<MediaSubscriptionResponseDto> {
    return this.service.subscribe(auth, dto);
  }

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.MediaSubscriptionRead })
  @Endpoint({ summary: 'List creator subscription progress', history: history() })
  getMediaSubscriptions(@Auth() auth: AuthDto): Promise<MediaSubscriptionListDto> {
    return this.service.subscriptions(auth);
  }

  @Patch(':id')
  @Authenticated({ permission: Permission.MediaSubscriptionWrite })
  @Endpoint({ summary: 'Pause, resume, check, disconnect or update a subscription', history: history() })
  updateMediaSubscription(
    @Auth() auth: AuthDto,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: MediaSubscriptionUpdateDto,
  ): Promise<MediaSubscriptionResponseDto> {
    return this.service.updateSubscription(auth, id, dto);
  }
}
